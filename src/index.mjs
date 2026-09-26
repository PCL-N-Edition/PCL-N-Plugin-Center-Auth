import { randomBytes } from 'node:crypto';
import { digest, verifyPassword } from './password.mjs';
class Failure extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const fail = (status, detail) => { throw new Failure(status, detail); };
const cookieName = scope => scope === 'operations' ? 'nexa_staff' : 'nexa_console';
const token = (request, scope) => (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(scope) + '='))?.split('=')[1] || '';
const scopeOf = scope => ['console', 'operations'].includes(scope) ? scope : fail(400, '无效会话范围');
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '需要 JSON 请求');
  const reader = request.body?.getReader(); if (!reader) fail(400, '缺少请求体');
  let bytes = 0; const parts = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) { await reader.cancel(); fail(413, '请求过大'); } parts.push(value); } } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { fail(400, '无效 JSON'); }
}
export default {
  async fetch(request, env) {
    const id = crypto.randomUUID(), url = new URL(request.url), path = url.pathname;
    try {
      const secure = env.LOCAL_DEV !== 'true';
      if (!env.WEB_ORIGIN || (secure && !env.WEB_ORIGIN.startsWith('https://'))) fail(503, '身份服务尚未配置');
      if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== env.WEB_ORIGIN || request.headers.get('x-nexa-request') !== '1')) fail(403, '请求来源无效');
      if (path === '/auth/v1/sessions' && request.method === 'POST') {
        const input = await body(request), scope = scopeOf(input?.scope);
        if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 80) fail(400, '无效账户名称');
        const now = Date.now(), key = digest(input.name.trim()), globalKey = 'all:' + Math.floor(now / 60000);
        const counters = await env.DB.batch([key, globalKey].map(k => env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count').bind(k, now + 60000, now, now)));
        if (counters[0].results[0].count > 8 || counters[1].results[0].count > 100) return json({ type: 'about:blank', title: 'Too Many Requests', status: 429, detail: '请求过于频繁', instance: url.pathname, requestId: id }, 429, { 'content-type': 'application/problem+json', 'retry-after': '60' });
        const user = await env.DB.prepare('SELECT * FROM users WHERE name=?').bind(input.name.trim()).first();
        if (!await verifyPassword(input.password, user?.password_hash) || !user || user.disabled || (scope === 'operations' && !user.staff)) fail(401, '账户或密码错误，或没有访问权限');
        const value = randomBytes(32).toString('base64url'), expires = now + (scope === 'operations' ? 3600000 : 86400000);
        const results = await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE token_hash=? OR expires<?').bind(digest(token(request, scope)), now),
          // Recheck credentials and privileges after password derivation; do not race a revocation.
          env.DB.prepare('INSERT INTO sessions(token_hash,user_id,scope,expires) SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=? AND disabled=0 AND (?=0 OR staff=1)').bind(digest(value), scope, expires, user.id, user.password_hash, scope === 'operations' ? 1 : 0),
          env.DB.prepare("INSERT INTO auth_audit(actor,action,created_at) SELECT ?,'session.created',? WHERE changes()=1").bind(user.id, new Date().toISOString()),
          env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now)
        ]);
        if (!results[1].meta.changes) fail(401, '账户状态已变更');
        const headers = { 'set-cookie': `${cookieName(scope)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${scope === 'operations' ? 3600 : 86400}${secure ? '; Secure' : ''}`, location: `/auth/v1/sessions/current?scope=${scope}` };
        return json({ id: user.id, name: user.name, scope }, 201, headers);
      }
      if (path === '/auth/v1/sessions/current') {
        const scope = scopeOf(url.searchParams.get('scope'));
        if (request.method === 'GET') {
          const user = await env.DB.prepare('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.scope=? AND s.expires>? AND u.disabled=0 AND (?=0 OR u.staff=1)').bind(digest(token(request, scope)), scope, Date.now(), scope === 'operations' ? 1 : 0).first();
          if (!user) fail(401, '请先登录'); return json({ ...user, scope });
        }
        if (request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND scope=?').bind(digest(token(request, scope)), scope).run();
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': `${cookieName(scope)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}` } });
        }
        return json({ type: 'about:blank', title: 'Method Not Allowed', status: 405, detail: '方法不支持' }, 405, { Allow: 'GET, DELETE', 'content-type': 'application/problem+json' });
      }
      if (path === '/auth/v1/sessions') return json({ type: 'about:blank', title: 'Method Not Allowed', status: 405, detail: '方法不支持' }, 405, { Allow: 'POST', 'content-type': 'application/problem+json' });
      fail(404, '接口不存在');
    } catch (error) {
      if (!error.status) console.error(JSON.stringify({ requestId: id, error: error.name }));
      return json({ type: 'about:blank', title: 'Request failed', status: error.status || 500, detail: error.status ? error.message : '身份服务暂时不可用', instance: path, requestId: id }, error.status || 500, { 'content-type': 'application/problem+json', 'x-request-id': id });
    }
  }
};
