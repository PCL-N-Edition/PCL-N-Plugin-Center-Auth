import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeMicrosoftToken, XBOX_SCOPE, XBOX_TOKEN } from '../src/microsoft.mjs';
import { AuthFlowError, safeAuthDiagnostic } from '../src/auth-flow-errors.mjs';

const config = { token: XBOX_TOKEN, clientId: 'nexa-test-client', clientSecret: 'private-client-secret-fixture' };
const parameters = { grant_type: 'authorization_code', code: 'private-code-fixture', redirect_uri: 'https://auth.test/callback', scope: XBOX_SCOPE, code_verifier: 'private-verifier-fixture' };
const secrets = ['private-access-fixture', 'private-refresh-fixture', 'private-description-fixture', config.clientSecret, parameters.code, parameters.code_verifier];
const reference = '12345678-1234-1234-1234-123456789012';

function assertFailure(error, { reason, httpStatus = null, providerCode = null }) {
  assert.ok(error instanceof AuthFlowError);
  assert.deepEqual(safeAuthDiagnostic(error, reference), { reference, stage: 'microsoft.token', reason, httpStatus, providerCode });
  const output = JSON.stringify(error) + error.message + error.stack + JSON.stringify(safeAuthDiagnostic(error, reference));
  for (const secret of secrets) assert.ok(!output.includes(secret), 'token redemption errors must not expose upstream or request secrets');
  assert.ok(!output.includes('error_description'));
  assert.equal(error.cause, undefined);
  return true;
}

test('successful redemption derives boolean facts from known granted scopes only', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    access_token: secrets[0], refresh_token: secrets[1],
    scope: 'XboxLive.SignIn\tXBOXLIVE.OFFLINE_ACCESS offline_access private-description-fixture',
    safeTokenFacts: { accessToken: secrets[0], clientSecret: config.clientSecret, xboxSignInGranted: false }
  }));
  const result = await exchangeMicrosoftToken(config, parameters);
  assert.equal(result.access_token, secrets[0]); assert.equal(result.refresh_token, secrets[1]);
  assert.deepEqual(result.safeTokenFacts, {
    accessTokenPresent: true, refreshTokenPresent: true, xboxSignInGranted: true, xboxOfflineGranted: true, standardOfflineGranted: true
  });
  for (const secret of secrets) assert.ok(!JSON.stringify(result.safeTokenFacts).includes(secret));
});

test('absent or invalid scopes and refresh tokens cannot make granted facts truthy', async t => {
  for (const [scope, refreshToken] of [[undefined, undefined], [null, null], [{ value: XBOX_SCOPE }, {}], ['unrecognized.permission', '']]) {
    await t.test(String(scope), async sub => {
      sub.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: secrets[0], scope, refresh_token: refreshToken }));
      assert.deepEqual((await exchangeMicrosoftToken(config, parameters)).safeTokenFacts, {
        accessTokenPresent: true, refreshTokenPresent: false, xboxSignInGranted: false, xboxOfflineGranted: false, standardOfflineGranted: false
      });
    });
  }
});

test('Xbox code redemption and refresh use form POSTs without following redirects, with separate deadlines', async t => {
  const signals = [], requests = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 12000);
    const signal = new AbortController().signal; signals.push(signal); return signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(init);
    assert.equal(url, XBOX_TOKEN); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), config.clientId); assert.equal(form.get('client_secret'), config.clientSecret);
    assert.equal(form.get('scope'), 'XboxLive.signin XboxLive.offline_access');
    assert.ok(!form.get('scope').includes('openid')); assert.ok(!form.get('scope').includes('User.Read'));
    return Response.json({ access_token: secrets[0] });
  });
  await exchangeMicrosoftToken(config, parameters);
  await exchangeMicrosoftToken(config, { grant_type: 'refresh_token', refresh_token: secrets[1], scope: XBOX_SCOPE });
  assert.equal(new URLSearchParams(requests[0].body).get('code_verifier'), parameters.code_verifier);
  assert.equal(new URLSearchParams(requests[0].body).get('redirect_uri'), parameters.redirect_uri);
  assert.equal(new URLSearchParams(requests[1].body).get('refresh_token'), secrets[1]);
  assert.equal(new URLSearchParams(requests[1].body).get('code'), null);
  assert.equal(signals.length, 2); assert.notEqual(signals[0], signals[1]);
  assert.equal(requests[0].signal, signals[0]); assert.equal(requests[1].signal, signals[1]);
});

test('HTTP failures preserve the first safe numeric provider code without copying response prose', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'invalid_grant', error_codes: [-1, '700016', 1.5, 700016, 7000215],
    error_description: secrets[2] + ' ' + config.clientSecret,
    access_token: secrets[0], refresh_token: secrets[1], client_secret: config.clientSecret
  }, { status: 400 }));
  await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason: 'http_error', httpStatus: 400, providerCode: 700016 }));
});

test('HTTP failures with malformed error bodies remain HTTP failures without invented provider codes', async t => {
  for (const response of [new Response(secrets[2], { status: 400 }), Response.json({ error_codes: [secrets[2], -1, 1.5] }, { status: 400 })]) {
    await t.test(response.headers.get('content-type'), async sub => {
      sub.mock.method(globalThis, 'fetch', async () => response);
      await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason: 'http_error', httpStatus: 400 }));
    });
  }
});

for (const [label, response] of [
  ['malformed JSON', new Response('<html>' + secrets[2] + '</html>')],
  ['null JSON', Response.json(null)],
  ['array JSON', Response.json([{ access_token: secrets[0] }])]
]) {
  test(`HTTP 200 with ${label} is an invalid token response`, async t => {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason: 'invalid_response', httpStatus: 200 }));
  });
}

test('successful JSON objects with missing or malformed access tokens cannot complete redemption', async t => {
  for (const token of [undefined, null, '', ' ', 7, { value: secrets[0] }]) {
    await t.test(typeof token + ':' + String(token), async sub => {
      sub.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: token, error_description: secrets[2], refresh_token: secrets[1] }));
      await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason: 'missing_token', httpStatus: 200 }));
    });
  }
});

for (const [name, reason] of [['TimeoutError', 'timeout'], ['AbortError', 'timeout'], ['TypeError', 'network_error']]) {
  test(`fetch ${name} identifies Microsoft token redemption and excludes the raw description`, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error(secrets.join(' ')), { name }); });
    await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason }));
  });
  test(`body ${name} retains the known HTTP status and excludes the raw description`, async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error(secrets.join(' ')), { name }); } }));
    await assert.rejects(exchangeMicrosoftToken(config, parameters), error => assertFailure(error, { reason, httpStatus: 200 }));
  });
}
