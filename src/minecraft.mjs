import { AuthFlowError, transportFailure } from './auth-flow-errors.mjs';

// Minecraft token exchange stays in the identity service; tokens are never stored.
export async function fetchMinecraftStatus(accessToken) {
  const hasToken = value => typeof value === 'string' && value.trim().length > 0;
  if (!hasToken(accessToken)) throw new AuthFlowError('xbox.user', 'missing_token', { message: 'msa:missing_token' });
  const invalidMessages = {
    'xbox.user': 'xbl:missing_token', 'xbox.xsts': 'xsts:missing_token',
    'minecraft.login': 'minecraft:missing_token', 'minecraft.entitlements': 'minecraft:invalid_entitlements',
    'minecraft.profile': 'minecraft:invalid_profile'
  };
  const appRegistrationDenied = data => ['error', 'errorMessage', 'developerMessage', 'message', 'Message', 'error_description'].some(field =>
    typeof data?.[field] === 'string' && /\binvalid\s+app\s+registration\b|\baka\.ms\/AppRegInfo\b/i.test(data[field]));
  const requestJson = async (stage, url, init, allowMissingProfile = false) => {
    let res;
    try { res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(12000) }); }
    catch (error) { throw transportFailure(stage, error); }
    if (allowMissingProfile && res.status === 404) return null;
    let data;
    try { data = await res.json(); }
    catch (error) {
      if (error?.name !== 'SyntaxError') {
        const failure = transportFailure(stage, error);
        throw new AuthFlowError(stage, failure.reason, { httpStatus: res.status });
      }
    }
    if (!res.ok) {
      const mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const responseFormat = mediaType === 'application/json' || mediaType.endsWith('+json') ? 'json' : mediaType === 'text/html' ? 'html' : mediaType.startsWith('text/') ? 'text' : 'other';
      const providerCode = ['xbox.user', 'xbox.xsts'].includes(stage) && Number.isSafeInteger(data?.XErr) && data.XErr >= 0 ? data.XErr : undefined;
      // Inspect only known response fields in memory; never copy their contents into errors.
      const appDenied = stage === 'minecraft.login' && appRegistrationDenied(data);
      // An HTML 403 establishes access rejection, not an account or app-permission cause.
      const connectionRejected = stage.startsWith('minecraft.') && res.status === 403 && responseFormat === 'html';
      throw new AuthFlowError(stage, appDenied ? 'app_not_permitted' : connectionRejected ? 'connection_rejected' : 'http_error', {
        httpStatus: res.status, providerCode, responseFormat, message: providerCode !== undefined ? `xbl:${providerCode}` : `http:${res.status}`
      });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AuthFlowError(stage, 'invalid_response', { httpStatus: res.status, message: invalidMessages[stage] });
    }
    return { data, httpStatus: res.status };
  };
  const postJson = (stage, url, body, headers = {}) => requestJson(stage, url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body)
  });
  const xboxHeaders = { 'x-xbl-contract-version': '1' };
  const { data: xbl, httpStatus: xblStatus } = await postJson('xbox.user', 'https://user.auth.xboxlive.com/user/authenticate', {
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + accessToken }
  }, xboxHeaders);
  if (!hasToken(xbl.Token)) throw new AuthFlowError('xbox.user', 'missing_token', { httpStatus: xblStatus, message: 'xbl:missing_token' });
  const { data: xsts, httpStatus: xstsStatus } = await postJson('xbox.xsts', 'https://xsts.auth.xboxlive.com/xsts/authorize', {
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    // SiteName belongs to User Authentication; it is not an XSTS property.
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }
  }, xboxHeaders);
  const uhs = xsts?.DisplayClaims?.xui?.[0]?.uhs ?? xbl?.DisplayClaims?.xui?.[0]?.uhs;
  if (!hasToken(uhs) || !hasToken(xsts.Token)) throw new AuthFlowError('xbox.xsts', 'missing_token', { httpStatus: xstsStatus, message: 'xsts:missing_token' });
  const { data: minecraft, httpStatus: minecraftStatus } = await postJson('minecraft.login', 'https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`
  });
  if (!hasToken(minecraft.access_token)) throw new AuthFlowError('minecraft.login', appRegistrationDenied(minecraft) ? 'app_not_permitted' : 'missing_token', { httpStatus: minecraftStatus, message: 'minecraft:missing_token' });
  const mcAuth = { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' };
  const { data: ent, httpStatus: entStatus } = await requestJson('minecraft.entitlements', 'https://api.minecraftservices.com/entitlements/mcstore', { headers: mcAuth });
  if (!Array.isArray(ent.items)) throw new AuthFlowError('minecraft.entitlements', 'invalid_response', { httpStatus: entStatus, message: 'minecraft:invalid_entitlements' });
  const owned = ent.items.some(item => item?.name === 'product_minecraft' || item?.name === 'game_minecraft');
  let profileId = null, profileName = null;
  if (owned) {
    const profile = await requestJson('minecraft.profile', 'https://api.minecraftservices.com/minecraft/profile', { headers: mcAuth }, true);
    if (profile) {
      if (!hasToken(profile.data.id)) throw new AuthFlowError('minecraft.profile', 'invalid_response', { httpStatus: profile.httpStatus, message: 'minecraft:invalid_profile' });
      profileId = profile.data.id; profileName = typeof profile.data.name === 'string' ? profile.data.name.slice(0, 32) : null;
    }
  }
  // accessToken：Minecraft 服务短时令牌，仅供实时下发（如启动器），绝不落库。
  return { owned: owned ? 1 : 0, profileId, profileName, accessToken: minecraft.access_token };
}
