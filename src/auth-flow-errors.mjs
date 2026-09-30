const stages = new Set(['microsoft.token', 'xbox.user', 'xbox.xsts', 'minecraft.login', 'minecraft.entitlements', 'minecraft.profile', 'grant.store', 'grant.save', 'unknown']);
const reasons = new Set(['http_error', 'network_error', 'timeout', 'invalid_response', 'missing_token', 'missing_refresh_token', 'app_not_permitted', 'configuration_missing', 'storage_error', 'state_changed', 'unexpected']);

export class AuthFlowError extends Error {
  constructor(stage, reason, { httpStatus, providerCode, message, tokenFacts, responseFormat } = {}) {
    super(message || `${stage}:${reason}`);
    this.name = 'AuthFlowError';
    this.stage = stages.has(stage) ? stage : 'unknown';
    this.reason = reasons.has(reason) ? reason : 'unexpected';
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    this.providerCode = Number.isSafeInteger(providerCode) && providerCode >= 0 ? providerCode : null;
    this.responseFormat = ['json', 'html', 'text', 'other'].includes(responseFormat) ? responseFormat : undefined;
    // Presence and known granted scopes are safe; token values and unknown scopes are excluded.
    this.tokenFacts = tokenFacts ? {
      accessTokenPresent: tokenFacts.accessTokenPresent === true,
      refreshTokenPresent: tokenFacts.refreshTokenPresent === true,
      xboxSignInGranted: tokenFacts.xboxSignInGranted === true,
      xboxOfflineGranted: tokenFacts.xboxOfflineGranted === true,
      standardOfflineGranted: tokenFacts.standardOfflineGranted === true
    } : undefined;
  }
}

export function transportFailure(stage, error) {
  if (error instanceof AuthFlowError) return error;
  return new AuthFlowError(stage, ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error');
}

export function safeAuthDiagnostic(error, reference) {
  const known = error instanceof AuthFlowError;
  return {
    reference: /^[0-9a-f-]{36}$/.test(reference) ? reference : null,
    stage: known ? error.stage : 'unknown',
    reason: known ? error.reason : 'unexpected',
    httpStatus: known ? error.httpStatus : null,
    providerCode: known ? error.providerCode : null,
    ...(known && error.responseFormat ? { responseFormat: error.responseFormat } : {}),
    ...(known && error.tokenFacts ? { tokenFacts: error.tokenFacts } : {})
  };
}

export function gameAuthorizationMessage(diagnostic) {
  const labels = { 'microsoft.token': 'Microsoft 令牌换取', 'xbox.user': 'Xbox 账户验证', 'xbox.xsts': 'Xbox 游戏权限验证', 'minecraft.login': 'Minecraft 服务登录', 'minecraft.entitlements': 'Minecraft 拥有状况读取', 'minecraft.profile': 'Minecraft 档案读取', 'grant.store': '游戏授权保管', 'grant.save': '游戏授权保存', unknown: 'Minecraft 授权' };
  let message;
  if (diagnostic.reason === 'state_changed') message = '游戏授权已失效或被撤销，请重新开始';
  else if (diagnostic.reason === 'missing_refresh_token') message = 'Microsoft 未返回持续授权令牌，游戏授权尚未保存';
  else if (diagnostic.reason === 'app_not_permitted') message = '当前网站应用未获准访问 Minecraft 服务，需由管理员处理';
  else if (diagnostic.stage === 'xbox.xsts' && diagnostic.providerCode === 2148916233) message = '所选 Microsoft 账户尚未创建 Xbox 资料，请先在 Xbox 完成账户设置';
  else if (diagnostic.reason === 'timeout') message = `${labels[diagnostic.stage] || labels.unknown}超时，请稍后重试`;
  else if (diagnostic.reason === 'network_error') message = `${labels[diagnostic.stage] || labels.unknown}连接失败，请稍后重试`;
  else message = `${labels[diagnostic.stage] || labels.unknown}未完成，请稍后重试`;
  const details = [diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}` : '', Number.isSafeInteger(diagnostic.providerCode) ? `错误码 ${diagnostic.providerCode}` : '', diagnostic.reference ? `诊断号 ${diagnostic.reference}` : ''].filter(Boolean);
  return message + (details.length ? `（${details.join('；')}）` : '');
}
