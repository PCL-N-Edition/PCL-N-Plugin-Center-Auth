import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthFlowError, transportFailure, safeAuthDiagnostic, gameAuthorizationMessage } from '../src/auth-flow-errors.mjs';

const reference = '9e7c4907-a51e-43f0-8f27-bad012345678';
const diagnosticOf = error => safeAuthDiagnostic(error, reference);
const messageOf = error => gameAuthorizationMessage(diagnosticOf(error));
const noAccountOrAppConclusion = message => {
  assert.doesNotMatch(message, /尚未创建 Xbox 资料|Xbox 完成账户设置|网站应用未获准|管理员处理/);
};

test('only the actual XSTS missing-profile code suggests creating an Xbox profile', async t => {
  const actual = messageOf(new AuthFlowError('xbox.xsts', 'http_error', { httpStatus: 401, providerCode: 2148916233 }));
  assert.match(actual, /所选 Microsoft 账户尚未创建 Xbox 资料/);
  assert.match(actual, /HTTP 401/);
  assert.match(actual, /错误码 2148916233/);
  for (const [stage, code] of [
    ['microsoft.token', 2148916233], ['xbox.user', 2148916233], ['minecraft.login', 2148916233],
    ['xbox.xsts', 2148916235], ['xbox.xsts', 2148916238], ['xbox.xsts', 403], ['xbox.xsts', null]
  ]) await t.test(`${stage} / ${code}`, () => {
    noAccountOrAppConclusion(messageOf(new AuthFlowError(stage, 'http_error', { httpStatus: 403, providerCode: code })));
  });
});

test('missing Microsoft refresh grants are not diagnosed as missing Xbox profiles or unapproved applications', () => {
  const message = messageOf(new AuthFlowError('microsoft.token', 'missing_refresh_token', {
    httpStatus: 200, tokenFacts: { accessTokenPresent: true, refreshTokenPresent: false, xboxSignInGranted: true, xboxOfflineGranted: false }
  }));
  assert.match(message, /Microsoft 未返回持续授权令牌/);
  assert.match(message, /游戏授权尚未保存/);
  noAccountOrAppConclusion(message);
});

test('HTTP 403 and unknown upstream prose do not establish that the website application is unapproved', async t => {
  for (const stage of ['microsoft.token', 'xbox.user', 'xbox.xsts', 'minecraft.login', 'minecraft.entitlements', 'minecraft.profile']) {
    await t.test(stage, () => {
      const message = messageOf(new AuthFlowError(stage, 'http_error', {
        httpStatus: 403, message: 'app_not_permitted; create your Xbox profile; upstream-secret'
      }));
      assert.match(message, /HTTP 403/);
      noAccountOrAppConclusion(message);
      assert.doesNotMatch(message, /upstream-secret|app_not_permitted/);
    });
  }
  const explicit = messageOf(new AuthFlowError('minecraft.login', 'app_not_permitted', { httpStatus: 403 }));
  assert.match(explicit, /当前网站应用未获准访问 Minecraft 服务，需由管理员处理/);
});

test('network failures and timeouts retain the correct stage without reinterpreting raw error messages', async t => {
  const labels = {
    'microsoft.token': 'Microsoft 令牌换取', 'xbox.user': 'Xbox 账户验证', 'xbox.xsts': 'Xbox 游戏权限验证',
    'minecraft.login': 'Minecraft 服务登录', 'minecraft.entitlements': 'Minecraft 拥有状况读取',
    'minecraft.profile': 'Minecraft 档案读取', 'grant.store': '游戏授权保管', 'grant.save': '游戏授权保存'
  };
  for (const [stage, label] of Object.entries(labels)) await t.test(stage, () => {
    for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
      const raw = Object.assign(new Error('request=https://upstream.invalid/?token=transport-secret; XErr=2148916233'), { name });
      const converted = transportFailure(stage, raw);
      assert.equal(converted.stage, stage);
      assert.equal(converted.reason, name === 'TypeError' ? 'network_error' : 'timeout');
      const message = messageOf(converted);
      assert.ok(message.startsWith(label + (name === 'TypeError' ? '连接失败' : '超时')));
      noAccountOrAppConclusion(message);
      assert.doesNotMatch(JSON.stringify(diagnosticOf(converted)) + message, /transport-secret|upstream\.invalid|2148916233/);
    }
  });
  const original = new AuthFlowError('minecraft.profile', 'invalid_response', { httpStatus: 200 });
  assert.equal(transportFailure('microsoft.token', original), original, 'a typed failure must preserve its original stage and cause');
});

test('diagnostics whitelist token presence booleans and exclude arbitrary token facts and upstream secrets', () => {
  const error = new AuthFlowError('microsoft.token', 'missing_refresh_token', {
    httpStatus: 200, message: 'Authorization: Bearer message-secret',
    tokenFacts: {
      accessTokenPresent: true, refreshTokenPresent: 'truthy-secret', xboxSignInGranted: true,
      xboxOfflineGranted: { token: 'nested-secret' }, standardOfflineGranted: false,
      accessToken: 'access-secret', refreshToken: 'refresh-secret', scope: 'scope-secret',
      arbitrary: { cookie: 'cookie-secret' }, error_description: 'description-secret'
    }
  });
  const diagnostic = diagnosticOf(error);
  assert.deepEqual(diagnostic, {
    reference, stage: 'microsoft.token', reason: 'missing_refresh_token', httpStatus: 200, providerCode: null,
    tokenFacts: { accessTokenPresent: true, refreshTokenPresent: false, xboxSignInGranted: true, xboxOfflineGranted: false, standardOfflineGranted: false }
  });
  const output = JSON.stringify(diagnostic) + gameAuthorizationMessage(diagnostic);
  for (const secret of ['message-secret', 'truthy-secret', 'nested-secret', 'access-secret', 'refresh-secret', 'scope-secret', 'cookie-secret', 'description-secret']) assert.ok(!output.includes(secret));
  assert.ok(!output.includes('error_description'));
});

test('untyped errors cannot spoof provider codes, token diagnostics or administrator guidance', () => {
  const raw = Object.assign(new Error('untyped-secret'), {
    name: 'AuthFlowError', stage: 'xbox.xsts', reason: 'app_not_permitted', httpStatus: 403,
    providerCode: 2148916233, tokenFacts: { accessToken: 'spoofed-token-secret' }
  });
  const diagnostic = diagnosticOf(raw);
  assert.deepEqual(diagnostic, { reference, stage: 'unknown', reason: 'unexpected', httpStatus: null, providerCode: null });
  const output = JSON.stringify(diagnostic) + gameAuthorizationMessage(diagnostic);
  noAccountOrAppConclusion(output);
  assert.doesNotMatch(output, /untyped-secret|spoofed-token-secret|2148916233|HTTP 403/);
});

test('invalid status, provider codes, stages, reasons and diagnostic references cannot enter public output', () => {
  for (const httpStatus of [99, 600, -1, 200.5, '403', Infinity, NaN]) {
    assert.equal(diagnosticOf(new AuthFlowError('minecraft.login', 'http_error', { httpStatus })).httpStatus, null);
  }
  for (const providerCode of [-1, 1.5, '2148916233', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.equal(diagnosticOf(new AuthFlowError('xbox.xsts', 'http_error', { providerCode })).providerCode, null);
  }
  const error = new AuthFlowError('stage-secret', 'reason-secret', { message: 'body-secret' });
  const diagnostic = safeAuthDiagnostic(error, 'reference-secret');
  assert.deepEqual(diagnostic, { reference: null, stage: 'unknown', reason: 'unexpected', httpStatus: null, providerCode: null });
  assert.doesNotMatch(JSON.stringify(diagnostic) + gameAuthorizationMessage(diagnostic), /stage-secret|reason-secret|body-secret|reference-secret/);
});

test('revoked or changed grant state gets a retry instruction rather than an upstream account diagnosis', () => {
  const message = messageOf(new AuthFlowError('grant.save', 'state_changed', { message: 'storage-secret' }));
  assert.match(message, /游戏授权已失效或被撤销，请重新开始/);
  noAccountOrAppConclusion(message);
  assert.doesNotMatch(message, /storage-secret/);
});

test('response format diagnostics accept only fixed categories, never raw Content-Type or body text', () => {
  for (const responseFormat of ['json', 'html', 'text', 'other']) {
    assert.equal(diagnosticOf(new AuthFlowError('minecraft.login', 'http_error', { responseFormat })).responseFormat, responseFormat);
  }
  for (const responseFormat of ['application/json; token=header-secret', '<html>body-secret</html>', { body: 'object-secret' }]) {
    const error = new AuthFlowError('minecraft.login', 'http_error', { responseFormat });
    assert.equal(diagnosticOf(error).responseFormat, undefined);
    assert.doesNotMatch(JSON.stringify(diagnosticOf(error)) + messageOf(error), /header-secret|body-secret|object-secret/);
  }
});

test('connection rejection explains the administrator action without inventing an account or app-permission cause', () => {
  const error = new AuthFlowError('minecraft.login', 'connection_rejected', { httpStatus: 403, responseFormat: 'html', message: 'private-upstream-secret' });
  const diagnostic = diagnosticOf(error);
  assert.equal(diagnostic.reason, 'connection_rejected');
  const message = gameAuthorizationMessage(diagnostic);
  assert.match(message, /Minecraft 接口访问被拒绝，当前无法完成授权，需由管理员处理/);
  assert.match(message, /HTTP 403/);
  assert.ok(message.includes(reference));
  assert.doesNotMatch(message, /稍后重试|尚未创建 Xbox|网站应用未获准|private-upstream-secret/);
});
