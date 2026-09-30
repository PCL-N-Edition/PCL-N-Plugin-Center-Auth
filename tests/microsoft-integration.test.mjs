import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { digest } from '../src/password.mjs';
import { decryptSecret } from '../src/totp.mjs';

test('Microsoft website identity and Xbox authorization stay separate in the Worker', async t => {
  const root = new URL('../', import.meta.url), fixtures = new Map(), calls = [], key = 'test-only-token-encryption-key';
  let gate = null;
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })), compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'microsoft-test' }, bindings: { WEB_ORIGIN: 'https://web.test', MICROSOFT_CLIENT_ID: 'app-fixture', MICROSOFT_CLIENT_SECRET: 'secret-fixture', TOKEN_ENC_KEY: key }, outboundService: async request => {
    const url = new URL(request.url); calls.push(url.href);
    if (url.hostname === 'login.microsoftonline.com') {
      assert.equal(request.method, 'POST');
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('client_secret'), 'secret-fixture');
      if (gate) { const waiting = gate; gate = null; waiting.started(); await waiting.resume; }
      if (url.pathname.includes('/consumers/')) {
        assert.equal(form.get('scope'), 'XboxLive.signin XboxLive.offline_access');
        assert.ok(!form.get('scope').includes('openid'));
        if (form.get('grant_type') === 'authorization_code') {
          const fixture = fixtures.get(form.get('code')); assert.ok(fixture); assert.equal(form.get('code_verifier'), fixture.code_verifier);
          assert.equal(form.get('redirect_uri'), 'https://auth.pcln.top/auth/v1/oauth/microsoft/callback');
        } else { assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'xbox-refresh'); }
        return Response.json({ access_token: 'xbox-msa-token', refresh_token: form.get('grant_type') === 'refresh_token' ? 'xbox-refresh-rotated' : 'xbox-refresh' });
      }
      assert.equal(url.pathname, '/common/oauth2/v2.0/token');
      assert.equal(form.get('scope'), 'openid profile email');
      const fixture = fixtures.get(form.get('code')); assert.ok(fixture); assert.equal(form.get('code_verifier'), fixture.code_verifier);
      return Response.json({ access_token: 'graph-token-' + fixture.user_id, id_token: 'e30.' + Buffer.from(JSON.stringify({ nonce: fixture.nonce })).toString('base64url') + '.fixture' });
    }
    if (url.hostname === 'graph.microsoft.com') {
      const authorization = request.headers.get('authorization'); assert.match(authorization, /^Bearer graph-token-/);
      const user = authorization.slice('Bearer graph-token-'.length);
      if (user === 'failed-profile') return Response.json({ error: 'private-upstream-error' }, { status: 503 });
      return Response.json({ sub: 'identity-' + user, name: 'Website identity', email: 'test@example.com' });
    }
    if (url.href === 'https://user.auth.xboxlive.com/user/authenticate') {
      assert.equal(request.headers.get('x-xbl-contract-version'), '1'); assert.equal((await request.json()).Properties.RpsTicket, 'd=xbox-msa-token');
      return Response.json({ Token: 'xbl-token' });
    }
    if (url.href === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
      assert.deepEqual((await request.json()).Properties.UserTokens, ['xbl-token']);
      return Response.json({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'game-user-hash' }] } });
    }
    if (url.href === 'https://api.minecraftservices.com/launcher/login') {
      assert.equal((await request.json()).xtoken, 'XBL3.0 x=game-user-hash;xsts-token'); return Response.json({ access_token: 'minecraft-token' });
    }
    assert.equal(request.headers.get('authorization'), 'Bearer minecraft-token');
    if (url.pathname === '/entitlements/mcstore') return Response.json({ items: [{ name: 'game_minecraft' }] });
    if (url.pathname === '/minecraft/profile') return Response.json({ id: 'a'.repeat(32), name: 'SeparateGameAccount' });
    assert.fail('Unexpected upstream: ' + url.href);
  } }));
  t.after(() => mf.dispose()); const DB = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL('migrations/' + file, root), 'utf8')).replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(s => DB.prepare(s)));
  }
  async function user(id, linked = true) {
    const token = 'session-' + id;
    await DB.batch([
      DB.prepare('INSERT INTO users(id,name,password_hash,confirmed_at,created_at) VALUES(?,?,?,?,?)').bind(id, id, 'oauth:test', new Date().toISOString(), new Date().toISOString()),
      DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token), id, Date.now() + 3600000),
      DB.prepare("INSERT INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,'terms-1.1',?)").bind(id, new Date().toISOString()),
      ...(linked ? [DB.prepare("INSERT INTO oauth_identities(provider,subject,user_id,created_at,updated_at) VALUES('microsoft',?,?,?,?)").bind('identity-' + id, id, new Date().toISOString(), new Date().toISOString())] : [])
    ]);
    return token;
  }
  const api = (path, token, method = 'GET') => mf.dispatchFetch('https://web.test' + path, { method, redirect: 'manual', headers: { cookie: 'nexa_console=' + token, origin: 'https://web.test', 'x-nexa-request': '1', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  async function start(token, purpose = 'minecraft') {
    const response = await api(purpose === 'minecraft' ? '/auth/v1/minecraft/authorizations' : '/auth/v1/oauth/microsoft/start?mode=link&return_to=%2Faccount%3Fsection%3Dlinked', token, purpose === 'minecraft' ? 'POST' : 'GET');
    assert.equal(response.status, purpose === 'minecraft' ? 201 : 302, await response.clone().text());
    const url = new URL(purpose === 'minecraft' ? (await response.json()).url : response.headers.get('location'));
    const row = await DB.prepare('SELECT * FROM oauth_states WHERE state=?').bind(url.searchParams.get('state')).first();
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(row.code_verifier).digest('base64url'));
    assert.equal(row.purpose, purpose); assert.ok(row.session_hash);
    const code = 'code-' + row.state; fixtures.set(code, row);
    return { url, row, code };
  }
  const callback = (authorization, extra = '') => mf.dispatchFetch('https://web.test/auth/v1/oauth/microsoft/callback?state=' + authorization.row.state + '&code=' + authorization.code + extra, { redirect: 'manual', headers: { cookie: 'nexa_oauth_state=' + authorization.row.state } });
  await t.test('ordinary Microsoft sign-in still creates a setup session and the shown policy receipts', async () => {
    const response = await api('/auth/v1/oauth/microsoft/start?tos=1.1', '', 'GET'); assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location')); assert.equal(url.searchParams.get('scope'), 'openid profile email');
    const row = await DB.prepare('SELECT * FROM oauth_states WHERE state=?').bind(url.searchParams.get('state')).first(); assert.equal(row.user_id, null);
    const code = 'code-' + row.state; fixtures.set(code, row); const before = calls.length;
    const completed = await callback({ row, code }); assert.equal(new URL(completed.headers.get('location')).pathname, '/register');
    assert.match(completed.headers.get('set-cookie'), /nexa_console=/);
    const account = await DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='microsoft' AND subject='identity-null'").first(); assert.ok(account);
    assert.equal((await DB.prepare('SELECT policy_id FROM privacy_notice_receipts WHERE user_id=?').bind(account.user_id).first()).policy_id, 'privacy-1.1');
    assert.deepEqual(calls.slice(before).map(u => new URL(u).hostname), ['login.microsoftonline.com', 'graph.microsoft.com']);
  });
  await t.test('ordinary Microsoft association uses only identity scopes and never calls Xbox', async () => {
    const token = await user('standard', false), authorization = await start(token, 'identity'), before = calls.length;
    assert.equal(authorization.url.searchParams.get('scope'), 'openid profile email');
    const response = await callback(authorization); assert.equal(response.status, 303); assert.equal(new URL(response.headers.get('location')).pathname, '/account');
    assert.deepEqual(calls.slice(before).map(u => new URL(u).hostname), ['login.microsoftonline.com', 'graph.microsoft.com']);
    assert.equal((await DB.prepare("SELECT subject FROM oauth_identities WHERE user_id='standard'").first()).subject, 'identity-standard');
    assert.equal(await DB.prepare("SELECT * FROM microsoft_tokens WHERE user_id='standard'").first(), null);
    assert.equal(await DB.prepare("SELECT * FROM minecraft_profiles WHERE user_id='standard'").first(), null);
  });
  await t.test('Xbox-only grant has PKCE, a separate token and encrypted refresh storage', async () => {
    const token = await user('game'), authorization = await start(token), before = calls.length;
    assert.equal(authorization.url.pathname, '/consumers/oauth2/v2.0/authorize');
    assert.equal(authorization.url.searchParams.get('scope'), 'XboxLive.signin XboxLive.offline_access');
    const response = await callback(authorization); assert.equal(new URL(response.headers.get('location')).searchParams.get('minecraft_success'), '1');
    assert.ok(!calls.slice(before).some(u => new URL(u).hostname === 'graph.microsoft.com'));
    const vault = await DB.prepare("SELECT * FROM microsoft_tokens WHERE user_id='game'").first();
    assert.equal(vault.grant_version, 1); assert.notEqual(vault.refresh_token_enc, 'xbox-refresh'); assert.equal(await decryptSecret(vault.refresh_token_enc, key), 'xbox-refresh');
    const status = await (await api('/auth/v1/account/minecraft', token)).json(); assert.equal(status.xboxAuthorized, true); assert.equal(status.profileName, 'SeparateGameAccount');
    assert.equal((await DB.prepare("SELECT subject FROM oauth_identities WHERE user_id='game'").first()).subject, 'identity-game');
    const replay = await callback(authorization); assert.ok(!new URL(replay.headers.get('location')).searchParams.has('minecraft_success'));
  });
  await t.test('refresh requests Xbox-only permissions and returns only a Minecraft token', async () => {
    const before = calls.length, response = await api('/auth/v1/minecraft/token', 'session-game', 'POST'); assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json(); assert.equal(result.accessToken, 'minecraft-token'); assert.equal(result.profileName, 'SeparateGameAccount');
    assert.ok(!calls.slice(before).some(u => new URL(u).hostname === 'graph.microsoft.com'));
    assert.equal(await decryptSecret((await DB.prepare("SELECT refresh_token_enc FROM microsoft_tokens WHERE user_id='game'").first()).refresh_token_enc, key), 'xbox-refresh-rotated');
  });
  await t.test('legacy mixed grants need explicit game authorization without any upstream exchange', async () => {
    const token = await user('legacy'); await DB.prepare("INSERT INTO microsoft_tokens(user_id,refresh_token_enc,obtained_at) VALUES('legacy','old-encrypted-token',?)").bind(new Date().toISOString()).run();
    const before = calls.length, response = await api('/auth/v1/minecraft/token', token, 'POST'); assert.equal(response.status, 409); assert.match((await response.json()).detail, /单独授权/); assert.equal(calls.length, before);
  });
  await t.test('cancelled or failed association is visible on the account page', async () => {
    const token = await user('failed-profile', false), standard = await start(token, 'identity');
    const response = await callback(standard), url = new URL(response.headers.get('location')); assert.equal(url.pathname, '/account'); assert.ok(url.searchParams.has('oauth_error')); assert.ok(!url.href.includes('private-upstream-error'));
    const gameToken = await user('cancelled'), cancelled = await start(gameToken);
    const url2 = new URL((await callback(cancelled, '&error=access_denied&error_description=secret-fixture')).headers.get('location')); assert.equal(url2.pathname, '/account'); assert.ok(url2.searchParams.has('minecraft_error')); assert.ok(!url2.href.includes('secret-fixture'));
  });
  await t.test('new authorizations revoke earlier choices and simultaneous callbacks consume once', async () => {
    const token = await user('replace'), old = await start(token), current = await start(token), before = calls.length;
    await callback(old); assert.equal(calls.length, before);
    const results = await Promise.all([callback(current), callback(current)]);
    assert.equal(results.filter(r => new URL(r.headers.get('location')).searchParams.has('minecraft_success')).length, 1);
  });
  await t.test('an older in-flight authorization cannot overwrite a newer completed choice', async () => {
    const token = await user('new-choice'), old = await start(token);
    let started, resume; const startedPromise = new Promise(r => { started = r; }), resumePromise = new Promise(r => { resume = r; });
    gate = { started, resume: resumePromise }; const pending = callback(old); await startedPromise;
    const newer = await start(token); assert.ok(new URL((await callback(newer)).headers.get('location')).searchParams.has('minecraft_success'));
    const saved = await DB.prepare("SELECT refresh_token_enc FROM microsoft_tokens WHERE user_id='new-choice'").first();
    resume(); assert.ok(new URL((await pending).headers.get('location')).searchParams.has('minecraft_error'));
    assert.equal((await DB.prepare("SELECT refresh_token_enc FROM microsoft_tokens WHERE user_id='new-choice'").first()).refresh_token_enc, saved.refresh_token_enc);
  });
  await t.test('logout before callback refuses both identity and game authorization', async () => {
    for (const purpose of ['identity', 'minecraft']) {
      const token = await user('logout-' + purpose), authorization = await start(token, purpose), before = calls.length;
      await DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(digest(token)).run();
      const response = await callback(authorization); assert.equal(new URL(response.headers.get('location')).pathname, '/account'); assert.equal(calls.length, before);
      assert.equal(await DB.prepare('SELECT * FROM microsoft_tokens WHERE user_id=?').bind(authorization.row.user_id).first(), null);
    }
  });
  await t.test('logout or unlink during exchange prevents the final game write', async () => {
    for (const action of ['logout', 'unlink']) {
      const token = await user('during-' + action), authorization = await start(token);
      let started, resume; const startedPromise = new Promise(r => { started = r; }), resumePromise = new Promise(r => { resume = r; });
      gate = { started, resume: resumePromise }; const pending = callback(authorization); await startedPromise;
      if (action === 'logout') await DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(digest(token)).run();
      else await api('/auth/v1/minecraft/authorization', token, 'DELETE');
      resume(); const response = await pending; assert.ok(new URL(response.headers.get('location')).searchParams.has('minecraft_error'));
      assert.equal(await DB.prepare('SELECT * FROM microsoft_tokens WHERE user_id=?').bind(authorization.row.user_id).first(), null);
      assert.equal(await DB.prepare('SELECT * FROM minecraft_profiles WHERE user_id=?').bind(authorization.row.user_id).first(), null);
    }
  });
  await t.test('logout during the standard identity exchange prevents identity creation', async () => {
    const token = await user('identity-revoked', false), authorization = await start(token, 'identity');
    let started, resume; const startedPromise = new Promise(r => { started = r; }), resumePromise = new Promise(r => { resume = r; });
    gate = { started, resume: resumePromise }; const pending = callback(authorization); await startedPromise;
    await DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(digest(token)).run(); resume();
    assert.ok(new URL((await pending).headers.get('location')).searchParams.has('oauth_error'));
    assert.equal(await DB.prepare("SELECT * FROM oauth_identities WHERE user_id='identity-revoked'").first(), null);
  });
  await t.test('revoking a game grant preserves Microsoft website identity', async () => {
    assert.equal((await api('/auth/v1/minecraft/authorization', 'session-game', 'DELETE')).status, 204);
    const status = await (await api('/auth/v1/account/minecraft', 'session-game')).json(); assert.equal(status.microsoftLinked, true); assert.equal(status.xboxAuthorized, false); assert.equal(status.checkedAt, null);
    assert.equal(await DB.prepare("SELECT * FROM microsoft_tokens WHERE user_id='game'").first(), null);
  });
  await t.test('revocation during refresh cannot restore a profile or return a game token', async () => {
    const token = await user('refresh-revoked'), authorization = await start(token); await callback(authorization);
    let started, resume; const startedPromise = new Promise(r => { started = r; }), resumePromise = new Promise(r => { resume = r; });
    gate = { started, resume: resumePromise }; const pending = api('/auth/v1/minecraft/token', token, 'POST'); await startedPromise;
    await api('/auth/v1/minecraft/authorization', token, 'DELETE'); resume();
    const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).accessToken, undefined);
    assert.equal(await DB.prepare("SELECT * FROM minecraft_profiles WHERE user_id='refresh-revoked'").first(), null);
    assert.equal(await DB.prepare("SELECT * FROM microsoft_tokens WHERE user_id='refresh-revoked'").first(), null);
  });
});
