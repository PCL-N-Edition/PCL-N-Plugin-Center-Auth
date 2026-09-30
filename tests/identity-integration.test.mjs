import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { digest, hashPassword } from '../src/password.mjs';
import { totpCode, encryptSecret } from '../src/totp.mjs';

const origin = 'https://web.test';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = 'a-test-password-with-24-chars';
const encryptionKey = 'test-only-encryption-key';

test('account and MFA endpoints run against actual Worker D1', async t => {
  const root = new URL('../', import.meta.url);
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })),
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'auth-integration' },
    bindings: { WEB_ORIGIN: origin, MFA_ENC_KEY: encryptionKey, SERVICE_TOKEN: 'test-only-service-token' }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    const statements = (await readFile(new URL('migrations/' + file, root), 'utf8')).replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    await db.batch(statements.map(s => db.prepare(s)));
    if (file === '0005_policies.sql') await db.prepare("INSERT INTO users(id,name,password_hash,staff) VALUES('legacy','legacy','oauth:legacy',1)").run();
  }
  const hash = await hashPassword(password);
  async function addUser(id, { pending = false, mfa = false, staff = 0 } = {}) {
    await db.prepare('INSERT INTO users(id,name,password_hash,staff,user_handle,password_set_at,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, id, hash, staff, id, Date.now(), new Date().toISOString(), pending ? null : new Date().toISOString()).run();
    const token = 'session-' + id;
    await db.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token), id, Date.now() + 3600000).run();
    if (mfa) await db.prepare('INSERT INTO mfa_totp(id,user_id,secret,confirmed,created_at) VALUES(?,?,?,1,?)').bind('totp-' + id, id, await encryptSecret(secret, encryptionKey), new Date().toISOString()).run();
    return token;
  }
  async function call(path, { method = 'GET', data, token, source = origin, headers = {} } = {}) {
    return mf.dispatchFetch(origin + path, { method, headers: { origin: source, 'x-nexa-request': '1', 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  const user = await addUser('aliceid', { mfa: true });
  const login = async id => {
    const response = await call('/auth/v1/login', { method: 'POST', data: { handle: id, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).challenge;
  };
  await t.test('existing users survive migrations and retain access', async () => {
    assert.ok((await db.prepare("SELECT confirmed_at FROM users WHERE id='legacy'").first()).confirmed_at);
    const { runAuthMaintenance } = await import('../src/index.mjs');
    await runAuthMaintenance({ DB: db });
    assert.equal((await db.prepare("SELECT count(*) AS n FROM users WHERE id='legacy'").first()).n, 1);
  });
  await t.test('password login enforces MFA and validates origin', async () => {
    await addUser('nomfaid');
    const response = await call('/auth/v1/login', { method: 'POST', data: { handle: 'nomfaid', password } });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'mfa_enrollment_required');
    assert.equal((await call('/auth/v1/login', { method: 'POST', source: 'https://evil.test', data: { handle: 'aliceid', password } })).status, 403);
    assert.equal((await call('/auth/v1/login', { method: 'POST', data: { handle: 'absentid', password } })).status, 401);
  });
  await t.test('a TOTP step wins once across simultaneous login challenges', async () => {
    const challenges = await Promise.all([login('aliceid'), login('aliceid')]);
    const code = await totpCode(secret);
    const responses = await Promise.all(challenges.map(challenge => call('/auth/v1/login/totp', { method: 'POST', data: { challenge, code } })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
    const success = responses.find(r => r.status === 200);
    assert.match(success.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict.*Secure/);
    const payload = await (await call('/auth/v1/tokens', { method: 'POST', data: {}, headers: { cookie: success.headers.get('set-cookie').split(';')[0] } })).json();
    assert.equal(payload.user.handle, 'aliceid'); assert.ok(payload.token);
    assert.equal((await call('/auth/v1/login/totp', { method: 'POST', data: { challenge: challenges[responses.indexOf(success)], code } })).status, 401);
  });
  await t.test('MFA attempts are bounded per account across challenges', async () => {
    await addUser('limitedid', { mfa: true });
    const challenge = await login('limitedid');
    for (let i = 0; i < 10; i++) assert.equal((await call('/auth/v1/login/totp', { method: 'POST', data: { challenge, code: 'bad' } })).status, 401);
    assert.equal((await call('/auth/v1/login/totp', { method: 'POST', data: { challenge, code: await totpCode(secret) } })).status, 429);
  });
  await t.test('recovery codes require reauthentication, are encrypted and consumed once', async () => {
    assert.equal((await call('/auth/v1/mfa/recovery/generate', { method: 'POST', token: user, data: {} })).status, 403);
    const generated = await call('/auth/v1/mfa/recovery/generate', { method: 'POST', token: user, data: { password } });
    assert.equal(generated.status, 201); const { codes } = await generated.json(); assert.equal(codes.length, 10);
    assert.match((await db.prepare("SELECT code_store FROM mfa_recovery_codes WHERE user_id='aliceid' LIMIT 1").first()).code_store, /^enc:/);
    assert.deepEqual((await (await call('/auth/v1/mfa/recovery/reveal', { method: 'POST', token: user, data: { password } })).json()).codes, codes);
    const challenge = await login('aliceid');
    assert.equal((await call('/auth/v1/login/totp', { method: 'POST', data: { challenge, code: codes[0] } })).status, 200);
    assert.equal((await call('/auth/v1/login/totp', { method: 'POST', data: { challenge: await login('aliceid'), code: codes[0] } })).status, 401);
  });
  await t.test('handle validation, uniqueness and cooldown are enforced', async () => {
    assert.equal((await call('/auth/v1/account/handle', { method: 'PUT', token: user, data: { handle: 'admin' } })).status, 400);
    assert.equal((await call('/auth/v1/account/handle', { method: 'PUT', token: user, data: { handle: 'nomfaid' } })).status, 409);
    assert.equal((await call('/auth/v1/account/handle', { method: 'PUT', token: user, data: { handle: 'newalice' } })).status, 200);
    assert.equal((await call('/auth/v1/account/handle', { method: 'PUT', token: user, data: { handle: 'otheralice' } })).status, 429);
  });
  await t.test('registration requires OAuth state, an unexpired factor and unique handle', async () => {
    const pending = await addUser('pendingid', { pending: true });
    assert.equal((await call('/auth/v1/register/complete', { method: 'POST', data: { name: 'New user', handle: 'newuser' } })).status, 401);
    assert.equal((await call('/auth/v1/register/complete', { method: 'POST', token: pending, data: { name: 'New user', handle: 'newuser', password } })).status, 400);
    const enrolled = await (await call('/auth/v1/mfa/totp/enroll', { method: 'POST', token: pending, data: {} })).json();
    const registered = await call('/auth/v1/register/complete', { method: 'POST', token: pending, data: { name: 'New user', handle: 'newuser', password, totpId: enrolled.id, totpCode: await totpCode(enrolled.secret) } });
    assert.equal(registered.status, 200, await registered.clone().text());
    const session = await (await call('/auth/v1/sessions/current?scope=console', { token: pending })).json();
    assert.equal(session.setupRequired, 0); assert.equal(session.handle, 'newuser');
    assert.equal((await call('/auth/v1/register/complete', { method: 'POST', token: pending, data: {} })).status, 409);
  });
  await t.test('internal XP requires service credentials and replay is idempotent', async () => {
    const data = { user: 'aliceid', events: [{ type: 'game.first_launch', dedupeKey: 'first' }] };
    assert.equal((await call('/internal/v1/xp', { method: 'POST', token: user, data })).status, 401);
    const apply = () => call('/internal/v1/xp', { method: 'POST', token: 'test-only-service-token', data });
    assert.equal((await (await apply()).json()).xp, 100);
    assert.equal((await (await apply()).json()).xp, 100);
    assert.equal((await call('/auth/v1/applications', { method: 'POST', token: user, data: { kind: 'admin' } })).status, 403);
    const concurrent = payload => call('/internal/v1/xp', { method: 'POST', token: 'test-only-service-token', data: payload });
    await addUser('parallelid');
    await Promise.all(['one','two'].map(dedupeKey => concurrent({ user: 'parallelid', events: [{ type: 'game.first_launch', dedupeKey }] })));
    assert.equal((await db.prepare("SELECT xp FROM user_levels WHERE user_id='parallelid'").first()).xp, 100);
    await Promise.all(['minutes-one','minutes-two'].map(dedupeKey => concurrent({ user: 'parallelid', events: [{ type: 'game.play_minutes', amount: 400, dedupeKey }] })));
    assert.equal((await db.prepare("SELECT xp FROM user_levels WHERE user_id='parallelid'").first()).xp, 600);
    assert.equal((await concurrent({ user: 'parallelid', events: [{ type: 'game.launch', occurredAt: 'not-a-date' }] })).status, 400);
  });
  await t.test('competing role reviews cannot both change permissions', async () => {
    const applicant = await addUser('candidate');
    const reviewerA = await addUser('reviewera', { staff: 1 }), reviewerB = await addUser('reviewerb', { staff: 1 });
    await db.prepare("INSERT INTO user_levels(user_id,xp,launched,updated_at) VALUES('candidate',10000,1,?)").bind(new Date().toISOString()).run();
    const application = await (await call('/auth/v1/applications', { method: 'POST', token: applicant, data: { kind: 'admin' } })).json();
    assert.ok(application.id);
    assert.equal((await call(`/auth/v1/applications/${application.id}/review`, { method: 'POST', token: applicant, data: { decision: 'approved' } })).status, 403);
    const responses = await Promise.all([[reviewerA, 'approved'], [reviewerB, 'rejected']].map(([token, decision]) => call(`/auth/v1/applications/${application.id}/review`, { method: 'POST', token, data: { decision } })));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.some(r => [404, 409].includes(r.status)));
    const final = await db.prepare('SELECT state FROM applications WHERE id=?').bind(application.id).first();
    assert.equal((await db.prepare("SELECT staff FROM users WHERE id='candidate'").first()).staff, final.state === 'approved' ? 1 : 0);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM auth_audit WHERE action='application.reviewed'").first()).n, 1);
  });
});
