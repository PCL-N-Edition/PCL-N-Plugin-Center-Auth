import { AuthFlowError, transportFailure } from './auth-flow-errors.mjs';

export const XBOX_SCOPE = 'XboxLive.signin XboxLive.offline_access';
export const XBOX_AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const XBOX_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

// Token redemption names exactly one resource. An Xbox token is never sent to Graph.
export async function exchangeMicrosoftToken(config, parameters) {
  let response;
  try { response = await fetch(config.token, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters })
  }); } catch (error) { throw transportFailure('microsoft.token', error); }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (error?.name !== 'SyntaxError') {
      const failure = transportFailure('microsoft.token', error);
      throw new AuthFlowError('microsoft.token', failure.reason, { httpStatus: response.status });
    }
  }
  if (!response.ok) {
    // Do not propagate upstream bodies, descriptions, tokens or client secrets.
    throw new AuthFlowError('microsoft.token', 'http_error', { httpStatus: response.status, providerCode: Array.isArray(data?.error_codes) ? data.error_codes.find(value => Number.isSafeInteger(value) && value >= 0) : null });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthFlowError('microsoft.token', 'invalid_response', { httpStatus: response.status });
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new AuthFlowError('microsoft.token', 'missing_token', { httpStatus: response.status });
  const scopes = new Set(typeof data.scope === 'string' ? data.scope.toLowerCase().split(/\s+/) : []);
  data.safeTokenFacts = { accessTokenPresent: true, refreshTokenPresent: typeof data.refresh_token === 'string' && Boolean(data.refresh_token), xboxSignInGranted: scopes.has('xboxlive.signin'), xboxOfflineGranted: scopes.has('xboxlive.offline_access'), standardOfflineGranted: scopes.has('offline_access') };
  return data;
}
