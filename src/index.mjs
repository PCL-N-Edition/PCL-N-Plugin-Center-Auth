import { randomBytes } from 'node:crypto';
import { digest } from './password.mjs';
import { createMailer } from './mailer.mjs';
class Failure extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const fail = (status, detail) => { throw new Failure(status, detail); };
const cookieName = scope => scope === 'operations' ? 'nexa_staff' : 'nexa_console';
const cookieValue = (request, name) => (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
const token = (request, scope) => cookieValue(request, cookieName(scope));
const bearer = request => (request.headers.get('authorization') || '').match(/^Bearer ([^\s]+)$/)?.[1] || '';
const credential = (request, scope) => bearer(request) || token(request, scope);
const scopeOf = scope => ['console', 'operations'].includes(scope) ? scope : fail(400, '无效会话范围');
const cors = env => ({ 'access-control-allow-origin': env.WEB_ORIGIN, 'access-control-allow-credentials': 'true' });
const json = (env, data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...cors(env), ...headers } });
const oauthStateCookie = 'nexa_oauth_state';
const oauthProviders = {
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', profile: 'https://api.github.com/user', callback: 'https://auth.pcln.top/auth/v1/oauth/github/callback', scope: 'read:user user:email' },
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', profile: 'https://graph.microsoft.com/oidc/userinfo', callback: 'https://auth.pcln.top/auth/v1/oauth/microsoft/callback', scope: 'openid profile email User.Read' },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', profile: 'https://openidconnect.googleapis.com/v1/userinfo', callback: 'https://auth.pcln.top/auth/v1/oauth/google/callback', scope: 'openid profile email' }
};
const providerPrefix = { github: 'GITHUB', microsoft: 'MICROSOFT', google: 'GOOGLE' };
const configFor = (provider, env) => {
  const config = { ...oauthProviders[provider], clientId: env[`${providerPrefix[provider]}_CLIENT_ID`], clientSecret: env[`${providerPrefix[provider]}_CLIENT_SECRET`] };
  if (!config.clientId || !config.clientSecret) fail(503, '该登录方式尚未配置');
  return config;
};
const b64json = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))));
const oauthError = (env, detail) => Response.redirect(`${env.WEB_ORIGIN}/account?oauth_error=${encodeURIComponent(detail)}`, 303);
const auditEvent = (env, actor, action, detail) => env.DB.prepare('INSERT INTO auth_audit(actor,action,created_at,detail) VALUES(?,?,?,?)').bind(actor, action, new Date().toISOString(), detail ?? null);
// 仅在前一条语句（INSERT OR IGNORE）实际写入时记录，用于条款首次接受等幂等事件。
const auditOnChange = (env, actor, action, detail) => env.DB.prepare('INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,?,?,? WHERE changes()=1').bind(actor, action, new Date().toISOString(), detail ?? null);
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '需要 JSON 请求');
  const reader = request.body?.getReader(); if (!reader) fail(400, '缺少请求体');
  let bytes = 0; const parts = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) { await reader.cancel(); fail(413, '请求过大'); } parts.push(value); } } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { fail(400, '无效 JSON'); }
}
async function currentPolicy(env, kind) {
  const policy = await env.DB.prepare('SELECT * FROM policy_documents WHERE kind=? AND current=1').bind(kind).first();
  if (!policy) fail(503, '政策文档尚未配置');
  return policy;
}
async function sessionUser(env, request, scope) {
  const value = credential(request, scope);
  if (!value) fail(401, '请先登录');
  const user = await env.DB.prepare(`SELECT u.id,COALESCE(u.display_name,u.name) AS name,u.email,u.staff,u.developer,
    EXISTS(SELECT 1 FROM terms_acceptances ta JOIN policy_documents pd ON pd.id=ta.policy_id AND pd.kind='terms' AND pd.current=1 WHERE ta.user_id=u.id) AS termsAccepted
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.scope=? AND s.expires>? AND u.disabled=0 AND (?=0 OR u.staff=1)`).bind(digest(value), scope, Date.now(), scope === 'operations' ? 1 : 0).first();
  if (!user) fail(401, '请先登录');
  return user;
}
async function createSession(env, user, scope, now, secure) {
  const value = randomBytes(32).toString('base64url');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,?,?)').bind(digest(value), user.id, scope, now + (scope === 'operations' ? 3600000 : 86400000))
  ]);
  return { value, cookie: `${cookieName(scope)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${scope === 'operations' ? 3600 : 86400}${secure ? '; Secure' : ''}` };
}
async function oauthStart(request, env, provider) {
  const config = configFor(provider, env), url = new URL(request.url);
  const returnPath = url.searchParams.get('return_to') || '/';
  if (!returnPath.startsWith('/') || returnPath.startsWith('//')) fail(400, '无效返回地址');
  const mode = url.searchParams.get('mode') === 'link' ? 'link' : 'login';
  let userId = null, termsPolicyId = null;
  if (mode === 'link') {
    const scope = scopeOf(url.searchParams.get('scope') || 'console');
    const current = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND scope=? AND expires>?').bind(digest(token(request, scope)), scope, Date.now()).first();
    if (!current) fail(401, '请先登录后再绑定身份');
    userId = current.user_id;
  } else {
    const terms = await currentPolicy(env, 'terms');
    if (url.searchParams.get('tos') !== terms.version) fail(400, '需要先接受当前版本的服务条款');
    termsPolicyId = terms.id;
  }
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), expires = Date.now() + 600000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<? OR consumed=1').bind(Date.now()),
    env.DB.prepare('INSERT INTO oauth_states(state,nonce,provider,return_to,user_id,terms_policy_id,expires,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(state, nonce, provider, returnPath, userId, termsPolicyId, expires, new Date().toISOString())
  ]);
  const authorize = new URL(config.authorize);
  authorize.searchParams.set('client_id', config.clientId); authorize.searchParams.set('redirect_uri', config.callback); authorize.searchParams.set('response_type', 'code'); authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', config.scope); authorize.searchParams.set('nonce', nonce);
  return new Response(null, { status: 302, headers: { location: authorize.toString(), 'set-cookie': `${oauthStateCookie}=${state}; HttpOnly; SameSite=Lax; Path=/auth/v1/oauth; Max-Age=600${env.LOCAL_DEV === 'true' ? '' : '; Secure'}`, 'cache-control': 'no-store' } });
}
async function oauthCallback(request, env, provider, secure) {
  const config = configFor(provider, env), url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.get('error')) return oauthError(env, '第三方登录未完成');
  const now = Date.now();
  const stateRow = await env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND provider=? AND consumed=0 AND expires>?').bind(state, provider, now).first();
  if (!stateRow || cookieValue(request, oauthStateCookie) !== state) return oauthError(env, '登录状态已失效，请重试');
  const consumed = await env.DB.prepare('UPDATE oauth_states SET consumed=1 WHERE state=? AND provider=? AND consumed=0 AND expires>?').bind(state, provider, now).run();
  if (!consumed.meta.changes) return oauthError(env, '登录状态已被使用，请重试');
  try {
    const tokenResponse = await fetch(config.token, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.callback, grant_type: 'authorization_code' }) });
    if (!tokenResponse.ok) throw new Error('token exchange failed');
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) throw new Error('missing access token');
    if (provider === 'microsoft' && tokenData.id_token) {
      const payload = b64json(tokenData.id_token.split('.')[1]);
      if (payload.nonce !== stateRow.nonce) throw new Error('nonce mismatch');
    }
    const profileResponse = await fetch(config.profile, { headers: { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/json', 'user-agent': 'nexa-auth' } });
    if (!profileResponse.ok) throw new Error('profile lookup failed');
    const profile = await profileResponse.json();
    const subject = String(provider === 'github' ? profile.id : (profile.sub || profile.id));
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase().slice(0, 320) : null;
    const displayName = String(profile.name || profile.login || profile.preferred_username || subject).slice(0, 160);
    let identity = await env.DB.prepare('SELECT user_id FROM oauth_identities WHERE provider=? AND subject=?').bind(provider, subject).first();
    let user;
    if (stateRow.user_id) {
      user = await env.DB.prepare('SELECT id,name,disabled FROM users WHERE id=?').bind(stateRow.user_id).first();
      if (!user || user.disabled) throw new Error('account disabled');
      if (identity && identity.user_id !== user.id) throw new Error('该第三方账号已绑定其他账户');
      if (!identity) {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO oauth_identities(provider,subject,user_id,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(provider, subject, user.id, email, new Date().toISOString(), new Date().toISOString()),
          auditEvent(env, user.id, 'oauth.linked', `${provider}:${subject}`)
        ]);
      }
    } else if (identity) {
      user = await env.DB.prepare('SELECT id,name,disabled FROM users WHERE id=?').bind(identity.user_id).first();
    } else {
      const id = crypto.randomUUID(), name = `${provider}:${subject}`;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users(id,name,password_hash,display_name,email) VALUES(?,?,?,?,?)").bind(id, name, `oauth:${randomBytes(32).toString('hex')}`, displayName, email),
        env.DB.prepare('INSERT INTO oauth_identities(provider,subject,user_id,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(provider, subject, id, email, new Date().toISOString(), new Date().toISOString())
      ]);
      user = { id, name, disabled: 0 };
    }
    if (!user || user.disabled) throw new Error('account disabled');
    await env.DB.prepare('UPDATE oauth_identities SET email=?,updated_at=? WHERE provider=? AND subject=?').bind(email, new Date().toISOString(), provider, subject).run();
    const headers = new Headers({ location: new URL(stateRow.return_to, env.WEB_ORIGIN).toString(), 'cache-control': 'no-store' });
    headers.append('set-cookie', `${oauthStateCookie}=; HttpOnly; SameSite=Lax; Path=/auth/v1/oauth; Max-Age=0${secure ? '; Secure' : ''}`);
    if (stateRow.user_id) return new Response(null, { status: 303, headers });
    await env.DB.prepare('UPDATE users SET display_name=?,email=? WHERE id=?').bind(displayName, email, user.id).run();
    if (stateRow.terms_policy_id) {
      // 条款接受与隐私告知随登录原子落库；INSERT OR IGNORE 保证已接受用户不会重复记录。
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,?,?)').bind(user.id, stateRow.terms_policy_id, new Date().toISOString()),
        auditOnChange(env, user.id, 'terms.accepted', stateRow.terms_policy_id),
        env.DB.prepare('INSERT OR IGNORE INTO privacy_notice_receipts(user_id,policy_id,provided_at) SELECT ?,?,? WHERE changes()=1').bind(user.id, (await currentPolicy(env, 'privacy')).id, new Date().toISOString())
      ]);
    }
    const session = await createSession(env, user, 'console', now, secure);
    headers.append('set-cookie', session.cookie);
    return new Response(null, { status: 303, headers });
  } catch (error) { console.error(JSON.stringify({ oauth: provider, error: error.name })); return oauthError(env, '第三方登录失败，请重试'); }
}
export async function finalizeAccountDeletion(env, requestId, userId) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM oauth_identities WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM oauth_states WHERE user_id=?').bind(userId),
    env.DB.prepare('UPDATE users SET name=?, display_name=NULL, email=NULL, disabled=1 WHERE id=? AND disabled=0').bind('deleted:' + userId, userId),
    env.DB.prepare("UPDATE account_deletion_requests SET state='finalized', finalized_at=?, version=version+1 WHERE id=? AND state='pending'").bind(now, requestId),
    env.DB.prepare('INSERT INTO deletion_tombstones(subject_id,deleted_at,deletion_version,reason) VALUES(?,?,1,?) ON CONFLICT(subject_id) DO UPDATE SET deleted_at=excluded.deleted_at, deletion_version=deletion_tombstones.deletion_version+1').bind(userId, now, 'user_requested'),
    auditEvent(env, userId, 'account.delete.completed', requestId)
  ]);
}
// NCL-007 保留清理 + NCL-008/009 注销冷静期执行；幂等、有界，供每日 cron 调用。
export async function runAuthMaintenance(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<? OR (consumed=1 AND expires<?)').bind(now, now - 86400000),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now)
  ]);
  const due = await env.DB.prepare("SELECT id,user_id FROM account_deletion_requests WHERE state='pending' AND execute_after<=? LIMIT 20").bind(now).all();
  for (const row of due.results) await finalizeAccountDeletion(env, row.id, row.user_id);
  return { finalized: due.results.length };
}
export default {
  async scheduled(controller, env, ctx) { await ctx.waitUntil(runAuthMaintenance(env)); },
  async fetch(request, env, ctx) {
    const id = crypto.randomUUID(), url = new URL(request.url), path = url.pathname;
    const mailer = createMailer(env);
    const later = task => { if (ctx?.waitUntil) ctx.waitUntil(task.catch(() => {})); };
    try {
      const secure = env.LOCAL_DEV !== 'true';
      if (!env.WEB_ORIGIN || (secure && !env.WEB_ORIGIN.startsWith('https://'))) fail(503, '身份服务尚未配置');
      if (request.method === 'OPTIONS' && path.startsWith('/auth/v1/')) return new Response(null, { status: 204, headers: { ...cors(env), 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-nexa-request, authorization', 'access-control-max-age': '600' } });
      if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== env.WEB_ORIGIN || request.headers.get('x-nexa-request') !== '1')) fail(403, '请求来源无效');
      const oauthMatch = path.match(/^\/auth\/v1\/oauth\/(github|microsoft|google)\/(start|callback)$/);
      if (oauthMatch && request.method === 'GET') return await (oauthMatch[2] === 'start' ? oauthStart(request, env, oauthMatch[1]) : oauthCallback(request, env, oauthMatch[1], secure));
      if (path === '/auth/v1/sessions' && request.method === 'POST') fail(404, '接口不存在');
      if (path === '/auth/v1/tokens' && request.method === 'POST') {
        const scope = scopeOf(url.searchParams.get('scope') || 'console');
        const user = await sessionUser(env, request, scope);
        const now = Date.now();
        const limit = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count').bind('mint:' + user.id, now + 3600000, now, now).first();
        if (limit.count > 60) fail(429, '凭证请求过于频繁');
        const session = await createSession(env, user, scope, now, secure);
        return json(env, { token: session.value, user: { ...user, scope } });
      }
      if (path === '/auth/v1/policies/accept' && request.method === 'POST') {
        const user = await sessionUser(env, request, 'console');
        const [terms, privacy] = await Promise.all([currentPolicy(env, 'terms'), currentPolicy(env, 'privacy')]);
        const now = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,?,?)').bind(user.id, terms.id, now),
          auditOnChange(env, user.id, 'terms.accepted', terms.id),
          env.DB.prepare('INSERT OR IGNORE INTO privacy_notice_receipts(user_id,policy_id,provided_at) SELECT ?,?,? WHERE changes()=1').bind(user.id, privacy.id, now)
        ]);
        return json(env, { ok: true, terms: { kind: 'terms', version: terms.version, effectiveAt: terms.effective_at, contentHash: terms.content_hash, acceptedAt: now } });
      }
      if (path === '/auth/v1/policies/status' && request.method === 'GET') {
        const user = await sessionUser(env, request, 'console');
        const rows = await env.DB.prepare(`SELECT pd.kind,pd.version,pd.effective_at AS effectiveAt,pd.content_hash AS contentHash,ta.accepted_at AS acceptedAt
          FROM policy_documents pd LEFT JOIN terms_acceptances ta ON ta.policy_id=pd.id AND ta.user_id=?
          WHERE pd.current=1 AND pd.kind IN ('terms','privacy') ORDER BY pd.kind`).bind(user.id).all();
        return json(env, { policies: rows.results });
      }
      if (path === '/auth/v1/identities' && request.method === 'GET') {
        const user = await sessionUser(env, request, 'console');
        const rows = await env.DB.prepare('SELECT provider,email,created_at FROM oauth_identities WHERE user_id=? ORDER BY created_at').bind(user.id).all();
        return json(env, { identities: rows.results });
      }
      const identityMatch = path.match(/^\/auth\/v1\/identities\/(github|microsoft|google)$/);
      if (identityMatch && request.method === 'DELETE') {
        const user = await sessionUser(env, request, 'console');
        const count = await env.DB.prepare('SELECT count(*) AS n FROM oauth_identities WHERE user_id=?').bind(user.id).first();
        if ((count?.n ?? 0) <= 1) fail(400, '至少保留一个登录方式');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM oauth_identities WHERE user_id=? AND provider=?').bind(user.id, identityMatch[1]),
          auditEvent(env, user.id, 'oauth.unlinked', identityMatch[1])
        ]);
        return json(env, { ok: true });
      }
      if (path === '/auth/v1/account/delete') {
        const user = await sessionUser(env, request, 'console');
        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT id,state,requested_at AS requestedAt,execute_after AS executeAfter,cancelled_at AS cancelledAt,finalized_at AS finalizedAt FROM account_deletion_requests WHERE user_id=?').bind(user.id).first();
          return json(env, { request: row ?? null, cooldownDays: 7 });
        }
        if (request.method === 'POST') {
          const existing = await env.DB.prepare("SELECT id,state,requested_at AS requestedAt,execute_after AS executeAfter FROM account_deletion_requests WHERE user_id=? AND state='pending'").bind(user.id).first();
          if (existing) return json(env, { request: existing, cooldownDays: 7 });
          const now = Date.now(), executeAfter = now + 7 * 86400000, requestId = crypto.randomUUID();
          await env.DB.batch([
            env.DB.prepare("INSERT INTO account_deletion_requests(id,user_id,state,requested_at,execute_after) VALUES(?,?,'pending',?,?)").bind(requestId, user.id, new Date().toISOString(), executeAfter),
            auditEvent(env, user.id, 'account.delete.requested', requestId)
          ]);
          if (user.email) later(mailer.accountDeletionRequested(user.email, new Date(executeAfter).toISOString()));
          return json(env, { request: { id: requestId, state: 'pending', requestedAt: new Date().toISOString(), executeAfter }, cooldownDays: 7 }, 201);
        }
        if (request.method === 'DELETE') {
          const result = await env.DB.prepare("UPDATE account_deletion_requests SET state='cancelled', cancelled_at=?, version=version+1 WHERE user_id=? AND state='pending'").bind(new Date().toISOString(), user.id).run();
          if (result.meta.changes) {
            await auditEvent(env, user.id, "account.delete.cancelled", null).run();
            if (user.email) later(mailer.accountDeletionCancelled(user.email));
          }
          return json(env, { ok: true, cancelled: Boolean(result.meta.changes) });
        }
      }
      if (path === '/auth/v1/account/export' && request.method === 'GET') {
        const user = await sessionUser(env, request, 'console');
        const [identities, sessions, acceptances, deletion, privacy] = await Promise.all([
          env.DB.prepare('SELECT provider,subject,email,created_at,updated_at FROM oauth_identities WHERE user_id=?').bind(user.id).all(),
          env.DB.prepare("SELECT scope, CASE WHEN expires>? THEN 'active' ELSE 'expired' END AS state FROM sessions WHERE user_id=?").bind(Date.now(), user.id).all(),
          env.DB.prepare('SELECT pd.kind,pd.version,ta.accepted_at AS acceptedAt FROM terms_acceptances ta JOIN policy_documents pd ON pd.id=ta.policy_id WHERE ta.user_id=?').bind(user.id).all(),
          env.DB.prepare('SELECT id,state,requested_at AS requestedAt,execute_after AS executeAfter,cancelled_at AS cancelledAt,finalized_at AS finalizedAt FROM account_deletion_requests WHERE user_id=?').bind(user.id).first(),
          env.DB.prepare('SELECT id,request_type AS type,state,created_at AS createdAt,updated_at AS updatedAt FROM privacy_requests WHERE user_id=? ORDER BY created_at').bind(user.id).all()
        ]);
        return json(env, {
          profile: { id: user.id, name: user.name, email: user.email, staff: user.staff, developer: user.developer },
          identities: identities.results, activeSessions: sessions.results, policyAcceptances: acceptances.results,
          deletionRequest: deletion ?? null, privacyRequests: privacy.results, exportedAt: new Date().toISOString()
        });
      }
      if (path === '/auth/v1/privacy-requests') {
        const user = await sessionUser(env, request, 'console');
        if (request.method === 'GET') {
          const rows = await env.DB.prepare('SELECT id,request_type AS type,state,created_at AS createdAt,updated_at AS updatedAt FROM privacy_requests WHERE user_id=? ORDER BY created_at').bind(user.id).all();
          return json(env, { requests: rows.results });
        }
        if (request.method === 'POST') {
          const input = await body(request);
          const types = ['access', 'correction', 'deletion', 'portability', 'objection', 'other'];
          if (!types.includes(input?.type)) fail(400, '无效的请求类型');
          const now = new Date().toISOString(), requestId = crypto.randomUUID();
          await env.DB.batch([
            env.DB.prepare("INSERT INTO privacy_requests(id,user_id,request_type,state,created_at,updated_at) VALUES(?,?,?,'received',?,?)").bind(requestId, user.id, input.type, now, now),
            auditEvent(env, user.id, 'privacy.request.created', input.type)
          ]);
          return json(env, { request: { id: requestId, type: input.type, state: 'received', createdAt: now, updatedAt: now } }, 201);
        }
      }
      if (path === '/auth/v1/sessions/current') {
        const scope = scopeOf(url.searchParams.get('scope'));
        if (request.method === 'GET') return json(env, { ...await sessionUser(env, request, scope), scope });
        if (request.method === 'DELETE') {
          const value = credential(request, scope);
          if (!value) fail(401, '请先登录');
          // 注销该用户当前范围的全部会话（含 auth 域 Cookie 会话），避免静默续签绕过登出。
          await env.DB.batch([
            env.DB.prepare('DELETE FROM sessions WHERE scope=? AND user_id=(SELECT user_id FROM sessions WHERE token_hash=? AND scope=?)').bind(scope, digest(value), scope),
            auditEvent(env, 'unknown', 'session.revoked', scope)
          ]);
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...cors(env), 'set-cookie': `${cookieName(scope)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}` } });
        }
        return json(env, { type: 'about:blank', title: 'Method Not Allowed', status: 405, detail: '方法不支持' }, 405, { Allow: 'GET, DELETE', 'content-type': 'application/problem+json' });
      }
      fail(404, '接口不存在');
    } catch (error) {
      if (!error.status) console.error(JSON.stringify({ requestId: id, error: error.name }));
      return json(env, { type: 'about:blank', title: 'Request failed', status: error.status || 500, detail: error.status ? error.message : '身份服务暂时不可用', instance: path, requestId: id }, error.status || 500, { 'content-type': 'application/problem+json', 'x-request-id': id });
    }
  }
};
