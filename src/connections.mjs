import { randomBytes } from 'node:crypto';
import { digest } from './password.mjs';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const providers = {
  bilibili: { name: 'B站', method: 'signature', available: false },
  afdian: { prefix: 'AFDIAN', name: '爱发电', authorize: 'https://afdian.com/oauth2/authorize', token: 'https://afdian.com/api/oauth2/access_token' }
};
const providerConfig = (env, provider) => {
  const config = providers[provider]; if (!config) fail(404, '关联平台不存在');
  if (config.available === false) fail(503, 'B站绑定暂未开放');
  return { ...config, clientId: env[config.prefix + '_CLIENT_ID'], clientSecret: env[config.prefix + '_CLIENT_SECRET'] };
};
const callbackUrl = (env, provider) => `${env.LOCAL_DEV === 'true' ? env.WEB_ORIGIN : 'https://auth.pcln.top'}/auth/v1/connections/${provider}/callback`;
const cookieName = provider => 'nexa_link_' + provider;
const cookie = (env, provider, value, age) => `${cookieName(provider)}=${value}; HttpOnly; SameSite=Lax; Path=/auth/v1/connections/${provider}; Max-Age=${age}${env.LOCAL_DEV === 'true' ? '' : '; Secure'}`;
const audit = (env, actor, action, detail, conditional = false) => env.DB.prepare(`INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,?,?,?${conditional ? ' WHERE changes()=1' : ''}`).bind(actor, action, new Date().toISOString(), detail);
export async function listConnections(env, userId) {
  const rows = await env.DB.prepare('SELECT provider,subject,display_name AS name,followers,connected_at AS connectedAt,checked_at AS checkedAt FROM external_connections WHERE user_id=?').bind(userId).all();
  return { connections: Object.keys(providers).map(provider => {
    const config = providers[provider];
    if (config.available === false) return { provider, label: config.name, method: config.method, configured: false, account: null };
    const credentials = providerConfig(env, provider);
    return { provider, label: config.name, method: 'oauth', configured: Boolean(credentials.clientId && credentials.clientSecret), account: rows.results.find(row => row.provider === provider) ?? null };
  }) };
}
export async function createConnectionAuthorization(env, user, sessionToken, provider) {
  if (user.setupRequired || !user.termsAccepted) fail(403, '请先完成注册并接受服务条款');
  const config = providerConfig(env, provider);
  if (!config.clientId || !config.clientSecret) fail(503, `${config.name}绑定暂未开放`);
  const state = randomBytes(32).toString('base64url');
  await env.DB.prepare('INSERT INTO connection_authorizations(state_hash,provider,user_id,session_hash,expires) VALUES(?,?,?,?,?)').bind(digest(state), provider, user.id, digest(sessionToken), Date.now() + 600000).run();
  const url = new URL(config.authorize);
  url.searchParams.set('client_id', config.clientId); url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', callbackUrl(env, provider));
  url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', 'basic');
  return { url: url.toString(), cookie: cookie(env, provider, state, 600) };
}
async function upstreamJson(fetcher, url, init) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
  catch { fail(502, '授权平台暂时不可用，请重新绑定'); }
  if (!response.ok) fail(502, '授权平台暂时不可用，请重新绑定');
  try { return await response.json(); } catch { fail(502, '授权平台响应无效'); }
}
export async function exchangeConnection(env, provider, code, fetcher = fetch) {
  const config = providerConfig(env, provider);
  if (!config.clientId || !config.clientSecret) fail(503, `${config.name}绑定暂未开放`);
  const params = { client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code };
  params.redirect_uri = callbackUrl(env, provider);
  const token = await upstreamJson(fetcher, config.token, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    if (token.ec !== 200 || typeof token.data?.user_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(token.data.user_id)) fail(502, '爱发电授权未成功，请重新绑定');
    // 官方接口可能仅返回 user_id；不要求 access_token、邮箱或昵称字段。
    return { subject: token.data.user_id, privateSubject: typeof token.data.user_private_id === 'string' ? token.data.user_private_id.slice(0, 128) : null, name: typeof token.data.name === 'string' ? token.data.name.slice(0, 160) : null, followers: null };
}
export async function completeConnectionAuthorization(request, env, provider, fetcher = fetch) {
  const url = new URL(request.url), state = url.searchParams.get('state') || '', code = url.searchParams.get('code');
  const browserState = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(provider) + '='))?.slice(cookieName(provider).length + 1);
  const target = new URL('/account?section=linked', env.WEB_ORIGIN);
  try {
    if (!state || state.length > 128 || browserState !== state) fail(400, '绑定状态无效，请重新开始');
    const row = await env.DB.prepare(`SELECT ca.* FROM connection_authorizations ca JOIN users u ON u.id=ca.user_id
      JOIN sessions s ON s.token_hash=ca.session_hash AND s.user_id=ca.user_id AND s.scope='console'
      WHERE ca.state_hash=? AND ca.provider=? AND ca.consumed=0 AND ca.expires>? AND s.expires>? AND u.disabled=0 AND u.confirmed_at IS NOT NULL`).bind(digest(state), provider, Date.now(), Date.now()).first();
    if (!row) fail(401, '绑定请求已失效或账户已退出，请重新登录');
    const consumed = await env.DB.prepare('UPDATE connection_authorizations SET consumed=1 WHERE state_hash=? AND consumed=0').bind(row.state_hash).run();
    if (!consumed.meta.changes) fail(409, '绑定请求已被使用');
    if (url.searchParams.has('error') || !code || code.length > 2048) fail(400, '已取消授权或授权码无效');
    const account = await exchangeConnection(env, provider, code, fetcher);
    const occupied = await env.DB.prepare('SELECT user_id FROM external_connections WHERE provider=? AND subject=?').bind(provider, account.subject).first();
    const current = await env.DB.prepare('SELECT subject FROM external_connections WHERE provider=? AND user_id=?').bind(provider, row.user_id).first();
    if (occupied && occupied.user_id !== row.user_id) fail(409, '该平台账户已关联其他Nexa账户');
    if (current && current.subject !== account.subject) fail(409, '请先解除现有绑定，再关联其他账户');
    const stamp = new Date().toISOString();
    const writes = [env.DB.prepare(`INSERT INTO external_connections(user_id,provider,subject,private_subject,display_name,followers,connected_at,checked_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.disabled=0 AND u.confirmed_at IS NOT NULL AND s.token_hash=? AND s.scope='console' AND s.expires>?)
      AND EXISTS(SELECT 1 FROM connection_authorizations WHERE state_hash=? AND user_id=? AND provider=? AND consumed=1 AND expires>?)
      ON CONFLICT(user_id,provider) DO UPDATE SET private_subject=excluded.private_subject,display_name=excluded.display_name,followers=excluded.followers,checked_at=excluded.checked_at
      WHERE subject=excluded.subject`).bind(row.user_id, provider, account.subject, account.privateSubject, account.name, account.followers, stamp, stamp, row.user_id, row.session_hash, Date.now(), row.state_hash, row.user_id, provider, Date.now()),
      audit(env, row.user_id, 'connection.linked', provider, true)];
    const [linked] = await env.DB.batch(writes);
    if (!linked.meta.changes) fail(409, '账户状态已改变，请重新登录或检查已有绑定');
    target.searchParams.set('connection_success', provider);
  } catch (error) {
    // 并发绑定由 UNIQUE(provider,subject) 作最终仲裁。不要输出授权码/令牌/平台响应。
    target.searchParams.set('connection_error', error.status ? error.message : '绑定冲突或服务暂不可用，请重试');
  }
  return new Response(null, { status: 303, headers: { location: target.toString(), 'set-cookie': cookie(env, provider, '', 0), 'cache-control': 'no-store' } });
}
export async function unlinkConnection(env, userId, provider) {
  if (!providers[provider]) fail(404, '关联平台不存在');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM external_connections WHERE user_id=? AND provider=?').bind(userId, provider),
    audit(env, userId, 'connection.unlinked', provider, true),
    env.DB.prepare('DELETE FROM connection_authorizations WHERE user_id=? AND provider=?').bind(userId, provider)
  ]);
}
