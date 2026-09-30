import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { loadLevel, loadProgression, recordActivity, selectLevelDisplay, computeLevel, activityDay } from '../src/progression.mjs';
import { digest } from '../src/password.mjs';
import { createConnectionAuthorization, completeConnectionAuthorization, exchangeConnection, listConnections, unlinkConnection } from '../src/connections.mjs';

test('progression and community bindings use atomic D1 writes', async t => {
  const root = new URL('../', import.meta.url), certificate = 'a'.repeat(64), now = Date.parse('2026-09-30T03:00:00Z');
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })), compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'progression-test' }, bindings: { WEB_ORIGIN: 'https://web.test', SERVICE_TOKEN: 'service-test-token', AFDIAN_CLIENT_ID: 'afdian-fixture', AFDIAN_CLIENT_SECRET: 'secret-fixture' }, outboundService: async request => {
    assert.equal(new URL(request.url).href, 'https://afdian.com/api/oauth2/access_token');
    assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('client_secret'), 'secret-fixture');
    assert.equal(form.get('code'), 'runtime-code');
    return Response.json({ ec: 200, data: { user_id: 'worker-runtime-subject' } });
  } }));
  t.after(() => mf.dispose()); const DB = await mf.getD1Database('DB'), env = { DB, WEB_ORIGIN: 'https://web.test', AFDIAN_CLIENT_ID: 'afdian-fixture', AFDIAN_CLIENT_SECRET: 'secret-fixture', BILIBILI_CLIENT_ID: 'bili-fixture', BILIBILI_CLIENT_SECRET: 'bili-secret-fixture' };
  for (const file of (await readdir(new URL('migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL('migrations/' + file, root), 'utf8')).replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(s => DB.prepare(s)));
  }
  async function addUser(id, staff = 0) {
    await DB.prepare('INSERT INTO users(id,name,user_handle,password_hash,staff,confirmed_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, id, id, 'oauth:test', staff, new Date().toISOString(), new Date().toISOString()).run();
    const token = 'session-' + id;
    await DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token), id, Date.now() + 3600000).run();
    return { id, staff, termsAccepted: 1, token };
  }
  const event = (type, id = randomUUID()) => ({ id, type });
  const api = (path, token, method = 'GET', data) => mf.dispatchFetch('https://web.test' + path, { method, headers: { origin: 'https://web.test', 'x-nexa-request': '1', authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  await t.test('all level boundaries and the first-game gate', async () => {
    for (const [xp, expected] of [[0,1],[1999,1],[2000,2],[5000,3],[10000,4],[20000,5],[50000,6],[100000,7]]) {
      assert.equal(computeLevel(xp, true), expected); assert.equal(computeLevel(xp, false), 0);
    }
    const user = await addUser('newlevel');
    assert.deepEqual((await loadLevel(env, user.id)).next, { level: 1, threshold: null, remaining: null, requirement: 'game.start' });
    await recordActivity(env, user, certificate, event('launcher.login'), now);
    assert.equal((await loadLevel(env, user.id)).level, 0);
    await recordActivity(env, user, certificate, event('game.start'), now);
    assert.equal((await loadLevel(env, user.id)).level, 1);
  });
  await t.test('replay, concurrent daily rewards and client-supplied XP', async () => {
    const user = await addUser('duplicates'), login = event('launcher.login');
    const replay = await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, login, now)));
    assert.equal(replay.filter(r => r.created).length, 1);
    await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, event('launcher.login'), now)));
    await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, event('game.start'), now)));
    assert.equal((await loadLevel(env, user.id)).xp, 50);
    assert.equal((await DB.prepare('SELECT sum(amount) AS n FROM xp_events WHERE user_id=?').bind(user.id).first()).n, 50);
    await assert.rejects(recordActivity(env, user, certificate, { ...event('game.start'), xp: 9999 }, now), e => e.status === 422);
    await assert.rejects(recordActivity(env, user, certificate, { ...event('game.start'), occurredAt: '2020-01-01' }, now), e => e.status === 422);
    await assert.rejects(recordActivity(env, user, 'b'.repeat(64), event('game.heartbeat'), now), e => e.status === 409);
    await assert.rejects(recordActivity(env, user, certificate, { ...login, type: 'game.start' }, now), e => e.status === 409);
  });
  await t.test('online time has no overlap, excludes long gaps and counts independently from the XP cap', async () => {
    const user = await addUser('online');
    await recordActivity(env, user, certificate, event('launcher.login'), now);
    await recordActivity(env, user, certificate, event('game.start'), now);
    for (let n = 1; n <= 5; n++) await recordActivity(env, user, certificate, event('game.heartbeat'), now + n * 60000);
    let progress = await loadProgression(env, user, now);
    assert.equal(progress.xp, 56); assert.equal(progress.activity.gameSeconds, 300); assert.equal(progress.activity.launcherSeconds, 300);
    await Promise.all([1,2].map(() => recordActivity(env, user, certificate, event('game.heartbeat'), now + 300000)));
    assert.equal((await loadProgression(env, user, now)).activity.gameSeconds, 300);
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3600000);
    progress = await loadProgression(env, user, now); assert.equal(progress.activity.gameSeconds, 300);
    await DB.prepare('UPDATE launcher_activity_days SET xp_earned=499 WHERE user_id=?').bind(user.id).run();
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3660000);
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3720000);
    progress = await loadProgression(env, user, now);
    assert.equal(progress.activity.todayXp, 500); assert.equal(progress.activity.gameSeconds, 420); assert.equal(progress.xp, 57);
    const gated = await addUser('capped');
    await DB.prepare('INSERT INTO launcher_activity_days(user_id,day,xp_earned) VALUES(?,?,500)').bind(gated.id, activityDay(now)).run();
    await recordActivity(env, gated, certificate, event('launcher.login'), now);
    await recordActivity(env, gated, certificate, event('game.start'), now);
    assert.equal((await loadLevel(env, gated.id)).level, 1); assert.equal((await loadLevel(env, gated.id)).xp, 0);
  });
  await t.test('daily rewards use Shanghai dates and streaks require consecutive launch days', async () => {
    const user = await addUser('midnight'), before = Date.parse('2026-09-29T15:59:59Z');
    await recordActivity(env, user, certificate, event('launcher.login'), before);
    await recordActivity(env, user, certificate, event('game.start'), before);
    await recordActivity(env, user, certificate, event('launcher.login'), before + 2000);
    await recordActivity(env, user, certificate, event('game.start'), before + 2000);
    const progress = await loadProgression(env, user, now); assert.equal(progress.xp, 100); assert.equal(progress.activity.currentStreak, 2);
    const streak = await addUser('streak');
    for (let n = 1; n <= 99; n++) await DB.prepare('INSERT INTO launcher_activity_days(user_id,day,game_started) VALUES(?,?,1)').bind(streak.id, activityDay(now - n * 86400000)).run();
    assert.equal((await loadProgression(env, streak, now)).badges.find(b => b.id === 'mc-streak').earned, false);
    await recordActivity(env, streak, certificate, event('launcher.login'), now);
    await recordActivity(env, streak, certificate, event('game.start'), now);
    assert.equal((await loadProgression(env, streak, now)).badges.find(b => b.id === 'mc-streak').earned, true);
    await selectLevelDisplay(env, streak, { badgeId: 'mc-streak' });
    assert.equal((await loadProgression(env, streak, now + 2 * 86400000)).activity.currentStreak, 0);
    assert.equal((await loadProgression(env, streak, now + 2 * 86400000)).display.label, 'LvMC');
  });
  await t.test('badge replacement never changes numeric level and infinity cannot bypass the missing quiz', async () => {
    const staff = await addUser('staffbadge', 1);
    assert.equal((await selectLevelDisplay(env, staff, { badgeId: 'administrator' })).display.label, 'Lv-1');
    assert.equal((await loadProgression(env, { ...staff, staff: 0 })).display.label, 'Lv0');
    assert.equal((await loadLevel(env, staff.id)).level, 0);
    await assert.rejects(selectLevelDisplay(env, staff, { badgeId: 'donor' }), e => e.status === 422);
    await DB.prepare('INSERT INTO user_levels(user_id,xp,launched,updated_at) VALUES(?,100000,1,?)').bind(staff.id, new Date().toISOString()).run();
    await DB.prepare('INSERT INTO launcher_presence(user_id,game_ms,updated_at) VALUES(?,360000000,?)').bind(staff.id, new Date().toISOString()).run();
    const infinity = (await loadProgression(env, staff)).badges.find(b => b.id === 'infinity');
    assert.equal(infinity.conditions.level, true); assert.equal(infinity.conditions.gameTime, true); assert.equal(infinity.earned, false);
    await assert.rejects(selectLevelDisplay(env, staff, { badgeId: 'infinity' }), e => e.status === 403);
  });
  await t.test('manual verification is staff-only, audited and donations must exceed 1000 CNY', async () => {
    const staff = await addUser('reviewer', 1), user = await addUser('recipient');
    const path = '/auth/v1/users/recipient/badge-verifications/donor', proof = { value: 100000, sourceAccount: 'receipt-1', evidence: '人工复核无偿捐赠凭证记录' };
    assert.equal((await api(path, user.token, 'PUT', proof)).status, 403);
    assert.equal((await api('/auth/v1/users/reviewer/badge-verifications/donor', staff.token, 'PUT', proof)).status, 403);
    assert.equal((await api(path, staff.token, 'PUT', proof)).status, 200);
    assert.equal((await loadProgression(env, user)).badges.find(b => b.id === 'donor').earned, false);
    proof.value = 100001;
    assert.equal((await api(path, staff.token, 'PUT', proof)).status, 200);
    assert.equal((await api(path, staff.token, 'PUT', proof)).status, 200);
    assert.equal((await loadProgression(env, user)).badges.find(b => b.id === 'donor').earned, true);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE action='badge.verified'").first()).n, 2);
    assert.equal((await api('/auth/v1/users/recipient/badge-verifications/infinity', staff.token, 'PUT', proof)).status, 422);
  });
  await t.test('Afdian accepts the official user-id-only response and never exposes credentials', async () => {
    const user = await addUser('afdianuser');
    const authorize = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const state = new URL(authorize.url).searchParams.get('state');
    assert.equal(new URL(authorize.url).hostname, 'afdian.com');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=test-code&state=' + state, { headers: { cookie: authorize.cookie.split(';')[0] } });
    let calls = 0;
    const fetcher = async (url, init) => {
      calls++; assert.equal(url, 'https://afdian.com/api/oauth2/access_token'); assert.equal(init.method, 'POST');
      assert.equal(init.body.get('redirect_uri'), 'https://auth.pcln.top/auth/v1/connections/afdian/callback');
      assert.equal(init.body.get('client_secret'), 'secret-fixture');
      return Response.json({ ec: 200, data: { user_id: 'afdian-subject-1', user_private_id: 'private-subject-1' } });
    };
    const wrongCookie = await completeConnectionAuthorization(new Request(incoming.url), env, 'afdian', fetcher);
    assert.ok(new URL(wrongCookie.headers.get('location')).searchParams.has('connection_error')); assert.equal(calls, 0);
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', fetcher);
    assert.equal(result.status, 303); assert.equal(new URL(result.headers.get('location')).searchParams.get('connection_success'), 'afdian'); assert.equal(calls, 1);
    await completeConnectionAuthorization(incoming, env, 'afdian', fetcher); assert.equal(calls, 1);
    const row = await DB.prepare('SELECT * FROM external_connections WHERE user_id=?').bind(user.id).first();
    assert.equal(row.subject, 'afdian-subject-1'); assert.ok(!JSON.stringify(row).includes('secret-fixture'));
    const duplicate = await addUser('afdianduplicate'), second = await createConnectionAuthorization(env, duplicate, duplicate.token, 'afdian');
    const conflict = await completeConnectionAuthorization(new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=other&state=' + new URL(second.url).searchParams.get('state'), { headers: { cookie: second.cookie.split(';')[0] } }), env, 'afdian', fetcher);
    assert.ok(new URL(conflict.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM external_connections').first()).n, 1);
  });
  await t.test('logout invalidates an OAuth binding even during the platform exchange', async () => {
    const user = await addUser('revokedlink'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=c&state=' + new URL(authorization.url).searchParams.get('state'), { headers: { cookie: authorization.cookie.split(';')[0] } });
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', async () => {
      await DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
      return Response.json({ ec: 200, data: { user_id: 'revoked-subject' } });
    });
    assert.ok(new URL(result.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM external_connections WHERE user_id=?').bind(user.id).first()).n, 0);
  });
  await t.test('policy revisions require explicit confirmation and repair privacy independently', async () => {
    const user = await addUser('policyrev');
    await DB.prepare("INSERT INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,'terms-1.0','2026-09-29T00:00:00Z')").bind(user.id).run();
    const status = await (await api('/auth/v1/policies/status', user.token)).json();
    assert.equal(status.policies.find(p => p.kind === 'terms').version, '1.1');
    assert.equal(status.policies.find(p => p.kind === 'terms').acceptedAt, null);
    assert.equal((await api('/auth/v1/policies/accept', user.token, 'POST', {})).status, 422);
    assert.equal((await api('/auth/v1/policies/accept', user.token, 'POST', { termsVersion: '1.0', privacyVersion: '1.0' })).status, 409);
    const input = { termsVersion: '1.1', privacyVersion: '1.1' };
    const first = await (await api('/auth/v1/policies/accept', user.token, 'POST', input)).json();
    await DB.prepare("DELETE FROM privacy_notice_receipts WHERE user_id=? AND policy_id='privacy-1.1'").bind(user.id).run();
    const second = await (await api('/auth/v1/policies/accept', user.token, 'POST', input)).json();
    assert.equal(second.terms.acceptedAt, first.terms.acceptedAt);
    const after = await (await api('/auth/v1/policies/status', user.token)).json();
    assert.ok(after.policies.find(p => p.kind === 'privacy').acceptedAt);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE actor=? AND action='terms.accepted'").bind(user.id).first()).n, 1);
    const exported = await (await api('/auth/v1/account/export', user.token)).json();
    assert.ok(Array.isArray(exported.activityDays)); assert.ok(Array.isArray(exported.activityEvents));
    assert.ok(!JSON.stringify(exported).includes(user.token));
  });
  await t.test('Afdian callback uses request options supported by the actual Worker runtime', async () => {
    const user = await addUser('afdruntime'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const state = new URL(authorization.url).searchParams.get('state');
    const result = await mf.dispatchFetch('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=runtime-code&state=' + state, { redirect: 'manual', headers: { cookie: authorization.cookie.split(';')[0] } });
    assert.equal(result.status, 303);
    assert.equal(new URL(result.headers.get('location')).searchParams.get('connection_success'), 'afdian');
    assert.equal((await DB.prepare('SELECT subject FROM external_connections WHERE user_id=?').bind(user.id).first()).subject, 'worker-runtime-subject');
  });
  await t.test('Bilibili remains closed even when old OAuth credentials exist', async () => {
    const user = await addUser('biliuser');
    const list = await listConnections(env, user.id);
    assert.equal(list.connections.find(c => c.provider === 'bilibili').configured, false);
    await assert.rejects(createConnectionAuthorization(env, user, user.token, 'bilibili'), { status: 503 });
    await assert.rejects(exchangeConnection(env, 'bilibili', 'code', () => { throw new Error('must not fetch'); }), { status: 503 });
  });
  await t.test('unlink cancels an OAuth exchange already in flight', async () => {
    const user = await addUser('unlinkrace'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=c&state=' + new URL(authorization.url).searchParams.get('state'), { headers: { cookie: authorization.cookie.split(';')[0] } });
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', async () => {
      await unlinkConnection(env, user.id, 'afdian');
      return Response.json({ ec: 200, data: { user_id: 'cancelled-subject' } });
    });
    assert.ok(new URL(result.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM external_connections WHERE user_id=?').bind(user.id).first()).n, 0);
  });
});
