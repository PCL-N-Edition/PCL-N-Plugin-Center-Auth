import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMinecraftStatus } from '../src/minecraft.mjs';
import { AuthFlowError, safeAuthDiagnostic, gameAuthorizationMessage } from '../src/auth-flow-errors.mjs';

const stages = ['xbox.user', 'xbox.xsts', 'minecraft.login', 'minecraft.entitlements', 'minecraft.profile'];
const diagnosticReference = '12345678-1234-1234-1234-123456789012';
const privateUpstreamText = 'private-upstream-token-should-never-escape';

const endpoints = [
  'https://user.auth.xboxlive.com/user/authenticate',
  'https://xsts.auth.xboxlive.com/xsts/authorize',
  'https://api.minecraftservices.com/launcher/login',
  'https://api.minecraftservices.com/entitlements/mcstore',
  'https://api.minecraftservices.com/minecraft/profile'
];
const responses = [
  { Token: 'xbl-user-token' },
  { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } },
  { access_token: 'minecraft-token' },
  { items: [{ name: 'game_minecraft' }] },
  { id: 'a'.repeat(32), name: 'Player' }
];

function mockExchange(t, overrides = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const index = calls.length;
    assert.equal(String(url), endpoints[index], 'each token must be sent only to its intended upstream');
    calls.push({ url: String(url), init });
    const response = overrides[index];
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response(url, init);
    if (response instanceof Response) return response;
    return Response.json(response === undefined ? responses[index] : response);
  });
  return calls;
}

test('Xbox exchange follows the official contract and isolates each derived token', async t => {
  const calls = mockExchange(t);
  const result = await fetchMinecraftStatus('msa-xbox-token');
  assert.deepEqual(result, { accessToken: 'minecraft-token', owned: 1, profileId: 'a'.repeat(32), profileName: 'Player' });
  assert.equal(calls.length, 5);
  for (const { init } of calls.slice(0, 2)) {
    const headers = new Headers(init.headers);
    assert.equal(init.method, 'POST');
    assert.equal(headers.get('x-xbl-contract-version'), '1');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorization'), null);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=msa-xbox-token' }
  });
  const xsts = JSON.parse(calls[1].init.body);
  assert.equal(xsts.RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(xsts.Properties.SandboxId, 'RETAIL');
  assert.deepEqual(xsts.Properties.UserTokens, ['xbl-user-token']);
  assert.deepEqual(JSON.parse(calls[2].init.body), { platform: 'PC_LAUNCHER', xtoken: 'XBL3.0 x=user-hash;xsts-token' });
  assert.equal(new Headers(calls[2].init.headers).get('x-xbl-contract-version'), null);
  for (const { init } of calls.slice(3)) assert.equal(new Headers(init.headers).get('authorization'), 'Bearer minecraft-token');
  assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
  assert.equal(new Set(calls.map(({ init }) => init.signal)).size, 5, 'each upstream has its own timeout');
  assert.ok(calls.every(({ init }) => init.redirect === 'manual'), 'tokens must not follow upstream redirects');
});

test('missing MSA tokens cannot start an upstream exchange', async t => {
  const calls = mockExchange(t);
  for (const token of [undefined, null, '', ' ', {}]) await assert.rejects(fetchMinecraftStatus(token), /msa:missing_token/);
  assert.equal(calls.length, 0);
});

for (const [name, index, response, error] of [
  ['Xbox user token missing', 0, {}, 'xbl:missing_token'],
  ['Xbox user token malformed', 0, { Token: {} }, 'xbl:missing_token'],
  ['XSTS token missing', 1, { DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }, 'xsts:missing_token'],
  ['XSTS user hash missing', 1, { Token: 'xsts-token' }, 'xsts:missing_token'],
  ['XSTS user hash malformed', 1, { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: {} }] } }, 'xsts:missing_token'],
  ['Minecraft token missing', 2, {}, 'minecraft:missing_token'],
  ['Minecraft token malformed', 2, { access_token: {} }, 'minecraft:missing_token']
]) {
  test(`${name} stops before the next upstream`, async t => {
    const calls = mockExchange(t, { [index]: response });
    await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), { message: error });
    assert.equal(calls.length, index + 1);
  });
}

test('Xbox account restrictions retain the upstream error code and stop the exchange', async t => {
  const calls = mockExchange(t, { 1: Response.json({ XErr: 2148916233, Message: privateUpstreamText }, { status: 401 }) });
  await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
    assert.equal(error.message, 'xbl:2148916233');
    assert.equal(error.stage, 'xbox.xsts'); assert.equal(error.reason, 'http_error');
    assert.equal(error.httpStatus, 401); assert.equal(error.providerCode, 2148916233);
    assertSafeFailure(error);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('an upstream HTTP failure never produces a game entitlement result', async t => {
  const calls = mockExchange(t, { 3: new Response('Unavailable', { status: 503 }) });
  await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), { message: 'http:503' });
  assert.equal(calls.length, 4);
});

test('upstream redirects are rejected before credentials can reach another endpoint', async t => {
  const calls = mockExchange(t, { 0: new Response(null, { status: 307, headers: { location: 'https://other.invalid/' } }) });
  await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), { message: 'http:307' });
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls.length, 1);
});

for (const [name, response] of [
  ['invalid JSON', new Response('<html>Unavailable</html>')],
  ['missing items', Response.json({})],
  ['invalid items', Response.json({ items: {} })]
]) {
  test(`entitlements with ${name} fail instead of claiming no ownership`, async t => {
    const calls = mockExchange(t, { 3: response });
    await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), { message: 'minecraft:invalid_entitlements' });
    assert.equal(calls.length, 4);
  });
}

test('an account without Minecraft ownership does not request a game profile', async t => {
  const calls = mockExchange(t, { 3: { items: [{ name: 'unrelated_product' }] } });
  assert.deepEqual(await fetchMinecraftStatus('msa-xbox-token'), { owned: 0, profileId: null, profileName: null, accessToken: 'minecraft-token' });
  assert.equal(calls.length, 4);
});

test('a profile that has not been created does not erase verified Minecraft ownership', async t => {
  const calls = mockExchange(t, { 3: { items: [{ name: 'product_minecraft' }] }, 4: new Response(null, { status: 404 }) });
  assert.deepEqual(await fetchMinecraftStatus('msa-xbox-token'), { owned: 1, profileId: null, profileName: null, accessToken: 'minecraft-token' });
  assert.equal(calls.length, 5);
});

function assertSafeFailure(error) {
  assert.ok(error instanceof AuthFlowError);
  const diagnostic = safeAuthDiagnostic(error, diagnosticReference);
  assert.equal(diagnostic.reference, diagnosticReference);
  const publicResult = JSON.stringify({ error, message: error.message, diagnostic, userMessage: gameAuthorizationMessage(diagnostic) });
  assert.ok(!publicResult.includes(privateUpstreamText), 'upstream bodies and transport descriptions must not reach diagnostics or users');
  for (const token of ['msa-xbox-token', 'xbl-user-token', 'xsts-token', 'minecraft-token']) assert.ok(!publicResult.includes(token));
}

for (const [index, stage] of stages.entries()) {
  test(`${stage} HTTP failures preserve only stage, status and safe metadata`, async t => {
    const calls = mockExchange(t, { [index]: Response.json({ errorMessage: privateUpstreamText, access_token: privateUpstreamText, XErr: privateUpstreamText }, { status: 503 }) });
    await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
      assert.equal(error.stage, stage); assert.equal(error.reason, 'http_error');
      assert.equal(error.httpStatus, 503); assert.equal(error.providerCode, null);
      assertSafeFailure(error); return true;
    });
    assert.equal(calls.length, index + 1);
  });
  for (const [name, reason] of [['TypeError', 'network_error'], ['TimeoutError', 'timeout']]) {
    test(`${stage} ${name} is diagnosed without exposing a transport description`, async t => {
      const failure = Object.assign(new Error(privateUpstreamText), { name });
      const calls = mockExchange(t, { [index]: failure });
      await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
        assert.equal(error.stage, stage); assert.equal(error.reason, reason);
        assert.equal(error.httpStatus, null); assert.equal(error.providerCode, null);
        assertSafeFailure(error); return true;
      });
      assert.equal(calls.length, index + 1);
    });
  }
}

test('Xbox error codes must be integers, never arbitrary provider text', async t => {
  for (const value of [privateUpstreamText, '2148916233', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(value), async sub => {
      mockExchange(sub, { 0: Response.json({ XErr: value, Message: privateUpstreamText }, { status: 401 }) });
      await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
        assert.equal(error.stage, 'xbox.user'); assert.equal(error.httpStatus, 401);
        assert.equal(error.providerCode, null); assert.equal(error.message, 'http:401');
        assertSafeFailure(error); return true;
      });
    });
  }
});

for (const [label, response, status, reason] of [
  ['explicit app registration denial', { errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo ' + privateUpstreamText }, 403, 'app_not_permitted'],
  ['explicit app registration marker with HTTP 200', { error: 'Invalid app registration ' + privateUpstreamText }, 200, 'app_not_permitted'],
  ['a plain forbidden response', { error: 'FORBIDDEN', errorMessage: privateUpstreamText }, 403, 'http_error'],
  ['an unrelated field containing the marker', { description: 'Invalid app registration ' + privateUpstreamText }, 403, 'http_error']
]) {
  test(`Minecraft login correctly diagnoses ${label}`, async t => {
    const calls = mockExchange(t, { 2: Response.json(response, { status }) });
    await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
      assert.equal(error.stage, 'minecraft.login'); assert.equal(error.reason, reason);
      assert.equal(error.httpStatus, status); assert.equal(error.providerCode, null);
      assertSafeFailure(error); return true;
    });
    assert.equal(calls.length, 3);
  });
}

test('invalid successful Minecraft profile responses are explicit failures', async t => {
  for (const response of [Response.json({}), new Response('<html>' + privateUpstreamText + '</html>')]) {
    await t.test(response.headers.get('content-type'), async sub => {
      const calls = mockExchange(sub, { 4: response });
      await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
        assert.equal(error.stage, 'minecraft.profile'); assert.equal(error.reason, 'invalid_response');
        assert.equal(error.httpStatus, 200); assertSafeFailure(error); return true;
      });
      assert.equal(calls.length, 5);
    });
  }
});

test('timing out while reading a response body preserves the request stage', async t => {
  mockExchange(t, { 3: () => ({ ok: true, status: 200, json: async () => { throw new DOMException(privateUpstreamText, 'AbortError'); } }) });
  await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), error => {
    assert.equal(error.stage, 'minecraft.entitlements'); assert.equal(error.reason, 'timeout');
    assert.equal(error.httpStatus, 200);
    assertSafeFailure(error); return true;
  });
});

test('an earlier expired deadline does not cancel later requests', async t => {
  const controllers = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 12000);
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), endpoints[index]);
    if (index > 0) controllers[index - 1].abort(new DOMException('Earlier deadline', 'TimeoutError'));
    assert.equal(init.signal, controllers[index].signal);
    assert.equal(init.signal.aborted, false, 'this request retains its own full timeout window');
    return Response.json(responses[index++]);
  });
  assert.equal((await fetchMinecraftStatus('msa-xbox-token')).owned, 1);
  assert.equal(controllers.length, 5);
});
