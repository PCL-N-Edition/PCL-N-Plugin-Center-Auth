import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMinecraftStatus } from '../src/minecraft.mjs';

test('Minecraft exchange uses Xbox tokens only to mint a Minecraft Bearer token', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/user/authenticate')) throw new Error('Unexpected endpoint');
    if (url === 'https://user.auth.xboxlive.com/authenticate') return Response.json({ Token: 'xbl' });
    if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
      assert.equal(JSON.parse(init.body).RelyingParty, 'rp://api.minecraftservices.com/');
      return Response.json({ Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'hash' }] } });
    }
    if (url === 'https://api.minecraftservices.com/launcher/login') {
      assert.equal(JSON.parse(init.body).xtoken, 'XBL3.0 x=hash;xsts');
      return Response.json({ access_token: 'minecraft-token' });
    }
    assert.equal(init.headers.Authorization, 'Bearer minecraft-token');
    if (String(url).endsWith('/entitlements/mcstore')) return Response.json({ items: [{ name: 'game_minecraft' }] });
    if (String(url).endsWith('/minecraft/profile')) return Response.json({ id: 'a'.repeat(32), name: 'Player' });
    throw new Error('Unexpected upstream');
  });
  const result = await fetchMinecraftStatus('msa-token');
  assert.equal(result.accessToken, 'minecraft-token'); assert.equal(result.owned, 1); assert.equal(result.profileName, 'Player');
  assert.equal(calls.length, 5);
});
