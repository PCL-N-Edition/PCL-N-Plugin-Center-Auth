export const XBOX_SCOPE = 'XboxLive.signin XboxLive.offline_access';
export const XBOX_AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const XBOX_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

// Token redemption names exactly one resource. An Xbox token is never sent to Graph.
export async function exchangeMicrosoftToken(config, parameters) {
  const response = await fetch(config.token, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
    // Do not propagate upstream bodies, descriptions, tokens or client secrets.
    throw new Error('Microsoft 授权换取失败，请重新授权');
  }
  return data;
}
