import { randomBytes } from 'node:crypto';
import { digest } from './password.mjs';
class Failure extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const fail = (status, detail) => { throw new Failure(status, detail); };
const cookieName = scope => scope === 'operations' ? 'nexa_staff' : 'nexa_console';
const token = (request, scope) => (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(scope) + '='))?.slice(cookieName(scope).length + 1) || '';
const oauthStateCookie = 'nexa_oauth_state';
const cookieValue = (request, name) => (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
const scopeOf = scope => ['console', 'operations'].includes(scope) ? scope : fail(400, '无效会话范围');
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
const oauthProviders = {
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', callback: 'https://auth.pcln.top/auth/v1/oauth/github/callback' },
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', callback: 'https://auth.pcln.top/auth/v1/oauth/microsoft/callback' }
};
const configFor = (provider, env) => {
  const prefix = provider === 'github' ? 'GITHUB' : 'MICROSOFT';
  const config = { ...oauthProviders[provider], clientId: env[`${prefix}_CLIENT_ID`], clientSecret: env[`${prefix}_CLIENT_SECRET`] };
  if (!config.clientId || !config.clientSecret) fail(503, '该登录方式尚未配置');
  return config;
};
const b64json = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))));
const oauthError = (env, detail) => Response.redirect(`${env.WEB_ORIGIN}/?oauth_error=${encodeURIComponent(detail)}`, 303);
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '需要 JSON 请求');
  const reader = request.body?.getReader(); if (!reader) fail(400, '缺少请求体');
  let bytes = 0; const parts = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) { await reader.cancel(); fail(413, '请求过大'); } parts.push(value); } } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { fail(400, '无效 JSON'); }
}
async function createSession(env, user, now, secure) {
  const value = randomBytes(32).toString('base64url');
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,?,?)').bind(digest(value), user.id, 'console', now + 86400000).run();
  return { value, cookie: `nexa_console=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? '; Secure' : ''}` };
}
async function oauthStart(request, env, provider) {
  const config = configFor(provider, env), url = new URL(request.url);
  const returnPath = url.searchParams.get('return_to') || '/';
  if (!returnPath.startsWith('/') || returnPath.startsWith('//')) fail(400, '无效返回地址');
  const mode = url.searchParams.get('mode') === 'link' ? 'link' : 'login';
  let userId = null;
  if (mode === 'link') {
    const scope = scopeOf(url.searchParams.get('scope') || 'console');
    const current = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND scope=? AND expires>?').bind(digest(token(request, scope)), scope, Date.now()).first();
    if (!current) fail(401, '请先登录后再绑定身份');
    userId = current.user_id;
  }
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), expires = Date.now() + 600000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<? OR consumed=1').bind(Date.now()),
    env.DB.prepare('INSERT INTO oauth_states(state,nonce,provider,return_to,user_id,expires,created_at) VALUES(?,?,?,?,?,?,?)').bind(state, nonce, provider, returnPath, userId, expires, new Date().toISOString())
  ]);
  const authorize = new URL(config.authorize);
  authorize.searchParams.set('client_id', config.clientId); authorize.searchParams.set('redirect_uri', config.callback); authorize.searchParams.set('response_type', 'code'); authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', provider === 'github' ? 'read:user user:email' : 'openid profile email User.Read'); authorize.searchParams.set('nonce', nonce);
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
    const profileResponse = await fetch(provider === 'github' ? 'https://api.github.com/user' : 'https://graph.microsoft.com/oidc/userinfo', { headers: { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/json', 'user-agent': 'nexa-auth' } });
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
      if (!identity) await env.DB.prepare('INSERT INTO oauth_identities(provider,subject,user_id,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(provider, subject, user.id, email, new Date().toISOString(), new Date().toISOString()).run();
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
    const session = await createSession(env, user, now, secure);
    headers.append('set-cookie', session.cookie);
    return new Response(null, { status: 303, headers });
  } catch (error) { console.error(JSON.stringify({ oauth: provider, error: error.name })); return oauthError(env, '第三方登录失败，请重试'); }
}
export default {
  async fetch(request, env) {
    const id = crypto.randomUUID(), url = new URL(request.url), path = url.pathname;
    try {
      const secure = env.LOCAL_DEV !== 'true';
      if (!env.WEB_ORIGIN || (secure && !env.WEB_ORIGIN.startsWith('https://'))) fail(503, '身份服务尚未配置');
      if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== env.WEB_ORIGIN || request.headers.get('x-nexa-request') !== '1')) fail(403, '请求来源无效');
      const oauthMatch = path.match(/^\/auth\/v1\/oauth\/(github|microsoft)\/(start|callback)$/);
      if (oauthMatch && request.method === 'GET') return await (oauthMatch[2] === 'start' ? oauthStart(request, env, oauthMatch[1]) : oauthCallback(request, env, oauthMatch[1], secure));
      if (path === '/auth/v1/sessions' && request.method === 'POST') fail(404, '接口不存在');
      if (path === '/auth/v1/sessions/current') {
        const scope = scopeOf(url.searchParams.get('scope'));
        if (request.method === 'GET') {
          const user = await env.DB.prepare('SELECT u.id,COALESCE(u.display_name,u.name) AS name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.scope=? AND s.expires>? AND u.disabled=0 AND (?=0 OR u.staff=1)').bind(digest(token(request, scope)), scope, Date.now(), scope === 'operations' ? 1 : 0).first();
          if (!user) fail(401, '请先登录'); return json({ ...user, scope });
        }
        if (request.method === 'DELETE') { await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND scope=?').bind(digest(token(request, scope)), scope).run(); return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': `${cookieName(scope)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}` } }); }
        return json({ type: 'about:blank', title: 'Method Not Allowed', status: 405, detail: '方法不支持' }, 405, { Allow: 'GET, DELETE', 'content-type': 'application/problem+json' });
      }
      fail(404, '接口不存在');
    } catch (error) {
      if (!error.status) console.error(JSON.stringify({ requestId: id, error: error.name }));
      return json({ type: 'about:blank', title: 'Request failed', status: error.status || 500, detail: error.status ? error.message : '身份服务暂时不可用', instance: path, requestId: id }, error.status || 500, { 'content-type': 'application/problem+json', 'x-request-id': id });
    }
  }
};
