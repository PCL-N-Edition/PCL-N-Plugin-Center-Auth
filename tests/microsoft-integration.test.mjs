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
  let gate = null, upstreamOverride = null;
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })), compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'microsoft-test' }, bindings: { WEB_ORIGIN: 'https://web.test', MICROSOFT_CLIENT_ID: 'app-fixture', MICROSOFT_CLIENT_SECRET: 'secret-fixture', TOKEN_ENC_KEY: key }, outboundService: async request => {
    const url = new URL(request.url); calls.push(url.href);
    if (upstreamOverride?.hostname === url.hostname && upstreamOverride.path === url.pathname) {
      const fixture = upstreamOverride; upstreamOverride = null;
      return Response.json(fixture.body, { status: fixture.status });
    }
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
      assert.deepEqual(await request.json(), {
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
        Properties: { SandboxId: 'RETAIL', UserTokens: ['xbl-token'] }
      });
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
  await t.test('game failures expose a traceable stage without leaking upstream secrets or saving partial grants', async t => {
    const pipeline = [
      ['login.microsoftonline.com', '/consumers/oauth2/v2.0/token'],
      ['user.auth.xboxlive.com', '/user/authenticate'],
      ['xsts.auth.xboxlive.com', '/xsts/authorize'],
      ['api.minecraftservices.com', '/launcher/login'],
      ['api.minecraftservices.com', '/entitlements/mcstore'],
      ['api.minecraftservices.com', '/minecraft/profile']
    ];
    const scenarios = [
      {
        id: 'missing-refresh', step: 0, stage: 'microsoft.token', reason: 'missing_refresh_token', status: 200, code: null,
        body: { access_token: 'xbox-msa-token', scope: 'XboxLive.signin XboxLive.offline_access unknown-scope-secret', safeTokenFacts: { refreshTokenPresent: true, accessToken: 'arbitrary-facts-secret' } },
        message: /Microsoft 未返回持续授权令牌，游戏授权尚未保存/,
        tokenFacts: { accessTokenPresent: true, refreshTokenPresent: false, xboxSignInGranted: true, xboxOfflineGranted: true, standardOfflineGranted: false }
      },
      {
        id: 'microsoft-denied', step: 0, stage: 'microsoft.token', reason: 'http_error', status: 400, code: 70000,
        body: { error: 'invalid_grant', error_codes: [70000], error_description: 'raw-description-secret; refresh_token=raw-refresh-secret', correlation_id: 'correlation-secret' },
        message: /Microsoft 令牌换取未完成/
      },
      {
        id: 'xbox-user-denied', step: 1, stage: 'xbox.user', reason: 'http_error', status: 401, code: 2148916233,
        body: { XErr: 2148916233, Message: 'raw-xbox-user-secret' },
        message: /Xbox 账户验证未完成/
      },
      {
        id: 'xsts-profile-missing', step: 2, stage: 'xbox.xsts', reason: 'http_error', status: 401, code: 2148916233,
        body: { XErr: 2148916233, Message: 'raw-xsts-secret' },
        message: /所选 Microsoft 账户尚未创建 Xbox 资料，请先在 Xbox 完成账户设置/
      },
      {
        id: 'minecraft-forbidden', step: 3, stage: 'minecraft.login', reason: 'http_error', status: 403, code: null,
        body: { error: 'Forbidden', errorMessage: 'raw-generic-forbidden-secret' },
        message: /Minecraft 服务登录未完成/
      },
      {
        id: 'explicit-app-registration', step: 3, stage: 'minecraft.login', reason: 'app_not_permitted', status: 403, code: null,
        body: { error: 'ForbiddenOperationException', errorMessage: 'Invalid app registration. See https://aka.ms/AppRegInfo raw-app-registration-secret' },
        message: /当前网站应用未获准访问 Minecraft 服务，需由管理员处理/
      },
      {
        id: 'profile-unavailable', step: 5, stage: 'minecraft.profile', reason: 'http_error', status: 503, code: null,
        body: { error: 'Service Unavailable', errorMessage: 'raw-profile-secret', access_token: 'profile-token-secret' },
        message: /Minecraft 档案读取未完成/
      }
    ];
    for (const scenario of scenarios) await t.test(scenario.id, async () => {
      const id = 'diagnostic-' + scenario.id, token = await user(id), authorization = await start(token), before = calls.length;
      const [hostname, path] = pipeline[scenario.step];
      assert.equal(upstreamOverride, null, 'previous one-shot failures must be consumed');
      upstreamOverride = { hostname, path, body: scenario.body, status: scenario.status };
      const response = await callback(authorization);
      assert.equal(upstreamOverride, null, 'the actual target upstream must have been reached');
      assert.equal(response.status, 303);
      const redirect = new URL(response.headers.get('location'));
      assert.equal(redirect.origin, 'https://web.test'); assert.equal(redirect.pathname, '/account'); assert.equal(redirect.searchParams.get('section'), 'linked');
      assert.equal(redirect.searchParams.has('minecraft_success'), false); assert.equal(redirect.searchParams.has('oauth_error'), false);
      const message = redirect.searchParams.get('minecraft_error');
      assert.match(message, scenario.message);
      const reference = message.match(/诊断号 ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/)?.[1];
      assert.ok(reference, 'every failure must provide its generated UUID diagnostic reference');
      assert.match(message, new RegExp(`HTTP ${scenario.status}`));
      if (scenario.code !== null) assert.match(message, new RegExp(`错误码 ${scenario.code}`));
      else assert.doesNotMatch(message, /错误码 /);
      if (scenario.stage !== 'xbox.xsts') assert.doesNotMatch(message, /尚未创建 Xbox 资料|Xbox 完成账户设置/);
      if (scenario.reason !== 'app_not_permitted') assert.doesNotMatch(message, /网站应用未获准|管理员处理/);
      assert.deepEqual(calls.slice(before).map(value => { const url = new URL(value); return [url.hostname, url.pathname]; }), pipeline.slice(0, scenario.step + 1), 'the chain must stop immediately at the failing stage');

      const audit = await DB.prepare("SELECT action,detail FROM auth_audit WHERE actor=? AND action='minecraft.authorization.failed'").bind(id).all();
      assert.equal(audit.results.length, 1);
      const diagnostic = JSON.parse(audit.results[0].detail);
      const expectedTokenFacts = scenario.tokenFacts ?? (scenario.step > 0 ? {
        accessTokenPresent: true, refreshTokenPresent: true, xboxSignInGranted: false, xboxOfflineGranted: false, standardOfflineGranted: false
      } : undefined);
      assert.deepEqual(Object.keys(diagnostic).sort(), ['reference', 'stage', 'reason', 'httpStatus', 'providerCode', ...(expectedTokenFacts ? ['tokenFacts'] : [])].sort());
      assert.equal(diagnostic.reference, reference); assert.equal(diagnostic.stage, scenario.stage); assert.equal(diagnostic.reason, scenario.reason);
      assert.equal(diagnostic.httpStatus, scenario.status); assert.equal(diagnostic.providerCode, scenario.code);
      if (expectedTokenFacts) assert.deepEqual(diagnostic.tokenFacts, expectedTokenFacts);
      const publicOutput = JSON.stringify(diagnostic) + message + decodeURIComponent(redirect.href);
      for (const secret of [
        'xbox-msa-token', 'xbox-refresh', 'xbl-token', 'xsts-token', 'minecraft-token', 'secret-fixture',
        'unknown-scope-secret', 'arbitrary-facts-secret', 'raw-description-secret', 'raw-refresh-secret', 'correlation-secret',
        'raw-xbox-user-secret', 'raw-xsts-secret', 'raw-generic-forbidden-secret', 'raw-app-registration-secret', 'raw-profile-secret', 'profile-token-secret',
        authorization.row.state, authorization.row.code_verifier, authorization.code
      ]) assert.ok(!publicOutput.includes(secret), 'diagnostic and browser feedback must exclude upstream bodies and credentials');
      assert.equal(await DB.prepare('SELECT * FROM microsoft_tokens WHERE user_id=?').bind(id).first(), null, 'a failed flow must not save a refresh grant');
      assert.equal(await DB.prepare('SELECT * FROM minecraft_profiles WHERE user_id=?').bind(id).first(), null, 'a failed flow must not save a partial profile');
      assert.equal((await DB.prepare("SELECT subject FROM oauth_identities WHERE user_id=? AND provider='microsoft'").bind(id).first()).subject, 'identity-' + id, 'a game authorization failure must preserve website identity');
    });
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
