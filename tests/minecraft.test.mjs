import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMinecraftStatus } from '../src/minecraft.mjs';

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
  const calls = mockExchange(t, { 1: Response.json({ XErr: 2148916233, Message: 'Account restriction' }, { status: 401 }) });
  await assert.rejects(fetchMinecraftStatus('msa-xbox-token'), { message: 'xbl:2148916233' });
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
