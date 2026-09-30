// Minecraft token exchange stays in the identity service; tokens are never stored.
export async function fetchMinecraftStatus(accessToken) {
  const signal = AbortSignal.timeout(12000);
  const postJson = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.XErr ? `xbl:${data.XErr}` : `http:${res.status}`);
    return data;
  };
  const xbl = await postJson('https://user.auth.xboxlive.com/authenticate', {
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + accessToken }
  });
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token], SiteName: 'user.auth.xboxlive.com' }
  });
  const uhs = xsts?.DisplayClaims?.xui?.[0]?.uhs ?? xbl?.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs || !xsts.Token) throw new Error('xsts:missing_token');
  const minecraft = await postJson('https://api.minecraftservices.com/launcher/login', {
    platform: 'PC_LAUNCHER', xtoken: `XBL3.0 x=${uhs};${xsts.Token}`
  });
  if (!minecraft.access_token) throw new Error('minecraft:missing_token');
  const mcAuth = { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' };
  const entRes = await fetch('https://api.minecraftservices.com/entitlements/mcstore', { headers: mcAuth, signal });
  if (!entRes.ok) throw new Error('http:' + entRes.status);
  const ent = await entRes.json().catch(() => ({}));
  const owned = Array.isArray(ent?.items) && ent.items.some(item => item?.name === 'product_minecraft' || item?.name === 'game_minecraft');
  let profileId = null, profileName = null;
  if (owned) {
    const profRes = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: mcAuth, signal });
    if (profRes.ok) {
      const prof = await profRes.json().catch(() => ({}));
      if (typeof prof?.id === 'string') { profileId = prof.id; profileName = typeof prof.name === 'string' ? prof.name.slice(0, 32) : null; }
    }
  }
  // accessToken：Minecraft 服务短时令牌，仅供实时下发（如启动器），绝不落库。
  return { owned: owned ? 1 : 0, profileId, profileName, accessToken: minecraft.access_token };
}
