import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliUid, readBilibiliProfile, createBilibiliProfileReader } from '../src/bilibili-profile.mjs';
import { createHash } from 'node:crypto';
import { deriveWbiKeys } from '../src/bilibili-wbi.mjs';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const fixture = () => ({ code: 0, data: { card: { mid: '689985040', name: '木雪1230_owo', face: 'https://i1.hdslb.com/bfs/face/test.jpg', sign: 'hello 大家好，我是木雪 1230！', level_info: { current_level: 5 } }, follower: 418 } });
test('signature verification explicitly bypasses display caches and never sends user credentials', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return Response.json(fixture()); };
  const first = await readBilibiliProfile('689985040', fetcher, { mode: 'verify-signature' }), second = await readBilibiliProfile('689985040', fetcher, { mode: 'verify-signature' });
  assert.equal(first.uid, '689985040'); assert.equal(first.level, 5); assert.equal(first.followers, 418);
  assert.equal(second.signature, fixture().data.card.sign);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(new URL(url).hostname, 'api.bilibili.com'); assert.equal(init.cache, 'no-store'); assert.equal(init.cf, undefined);
    assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.authorization, undefined); assert.equal(init.redirect, 'manual');
    assert.deepEqual([...new URL(url).searchParams.keys()], ['mid']);
  }
});
test('missing, mismatched, throttled and malformed profiles fail explicitly', async () => {
  for (const value of ['', '0', '001', '1&mid=2', 123, '999999999999999999999']) assert.throws(() => bilibiliUid(value), { status: 422 });
  for (const [response, status] of [
    [new Response('', { status: 429 }), 503], [new Response('', { status: 412 }), 503],
    [Response.json({ code: -404 }), 404], [Response.json({ code: -400 }), 503],
    [Response.json({ code: 0, data: {} }), 502], [new Response('<html>'), 502],
    [new Response('x'.repeat(131073)), 502], [new Response('', { status: 302, headers: { location: 'https://evil.test/' } }), 502]
  ]) await assert.rejects(readBilibiliProfile('689985040', async () => response), { status });
  const wrong = fixture(); wrong.data.card.mid = '1';
  await assert.rejects(readBilibiliProfile('689985040', async () => Response.json(wrong)), { status: 502 });
  await assert.rejects(readBilibiliProfile('689985040', async () => { throw new Error('timeout'); }), { status: 502 });
});

test('same UID/mode shares one read; verification never joins an older display request', async () => {
  let count = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = createBilibiliProfileReader({ fetcher: async () => { count++; await gate; return Response.json(fixture()); } });
  const displays = Array.from({ length: 10 }, () => reader.read('689985040'));
  const verifications = Array.from({ length: 10 }, () => reader.read('689985040', { mode: 'verify-signature' }));
  assert.equal(count, 2);
  release();
  const profiles = await Promise.all([...displays, ...verifications]);
  assert.equal(profiles.length, 20);
  assert.equal(profiles[0], profiles[9]);
  assert.equal(profiles[10], profiles[19]);
});

test('display cache is bounded in time, while a fresh verification reads current upstream data', async () => {
  let clock = 1702204169000, count = 0;
  const reader = createBilibiliProfileReader({ now: () => clock, displayTtlMs: 1000, maxProfiles: 1, fetcher: async () => {
    count++; const profile = fixture(); profile.data.card.sign = `signature-${count}`; return Response.json(profile);
  } });
  assert.equal((await reader.read('689985040')).signature, 'signature-1');
  assert.equal((await reader.read('689985040')).signature, 'signature-1');
  assert.equal(count, 1);
  assert.equal((await reader.read('689985040', { mode: 'verify-signature' })).signature, 'signature-2');
  assert.equal((await reader.read('689985040')).signature, 'signature-2');
  clock += 1001;
  assert.equal((await reader.read('689985040')).signature, 'signature-3');
});

test('HTTP 412 HTML is distinguished from JSON -412 and opens a cross-UID circuit with no retries', async () => {
  for (const response of [new Response('<html>blocked</html>', { status: 412, headers: { 'content-type': 'text/html; charset=utf-8' } }), Response.json({ code: -412, message: '请求被拦截' })]) {
    let count = 0, clock = 1702204169000; const diagnostics = [];
    const reader = createBilibiliProfileReader({ now: () => clock, breakerMs: 1000, onDiagnostic: value => diagnostics.push(value), fetcher: async () => { count++; return count === 1 ? response : Response.json(fixture()); } });
    await assert.rejects(reader.read('689985040', { mode: 'verify-signature' }), error => {
      assert.equal(error.status, 503); assert.equal(error.retryAfterSeconds, 1);
      if (response.status === 412) { assert.equal(error.diagnostic.httpStatus, 412); assert.equal(error.diagnostic.contentType, 'text/html'); assert.equal(error.diagnostic.businessCode, null); }
      else { assert.equal(error.diagnostic.httpStatus, 200); assert.equal(error.diagnostic.contentType, 'application/json'); assert.equal(error.diagnostic.businessCode, -412); assert.equal(error.diagnostic.businessMessage, '请求被拦截'); }
      return true;
    });
    await assert.rejects(reader.read('1', { mode: 'verify-signature', source: 'wbi' }), { status: 503 });
    await assert.rejects(reader.readFollowers('1'), { status: 503 });
    assert.equal(count, 1); assert.equal(diagnostics.length, 1);
    clock += 1001;
    assert.equal((await reader.read('689985040', { mode: 'verify-signature' })).uid, '689985040');
    assert.equal(count, 2);
  }
});

test('an error never substitutes a cached display signature for verification', async () => {
  let count = 0;
  const reader = createBilibiliProfileReader({ fetcher: async () => ++count === 1 ? Response.json(fixture()) : new Response('blocked', { status: 412, headers: { 'content-type': 'text/html' } }) });
  await reader.read('689985040');
  await assert.rejects(reader.read('689985040', { mode: 'verify-signature' }), { status: 503 });
  assert.equal((await reader.read('689985040')).signature, fixture().data.card.sign);
  await assert.rejects(reader.read('689985040', { mode: 'verify-signature' }), { status: 503 });
  assert.equal(count, 2);
});

test('diagnostics retain safe response facts and fetch failure classifications without profile data', async () => {
  const diagnostics = [];
  const sensitive = `${fixture().data.card.name} ${fixture().data.card.sign} SESSDATA=secret`;
  const reader = createBilibiliProfileReader({ onDiagnostic: value => diagnostics.push(value), fetcher: async () => Response.json({ code: -400, message: sensitive }) });
  await assert.rejects(reader.read('689985040'), error => { assert.equal(error.diagnostic.businessCode, -400); assert.equal(error.diagnostic.businessMessage, null); return true; });
  const output = JSON.stringify(diagnostics);
  assert.equal(output.includes('SESSDATA'), false); assert.equal(output.includes(fixture().data.card.name), false); assert.equal(output.includes(fixture().data.card.sign), false);
  for (const [error, expected] of [[new TypeError('Unsupported cache mode: no-store secret'), 'cache_configuration'], [new TypeError('Invalid redirect mode secret'), 'redirect_configuration'], [Object.assign(new Error(sensitive), { name: 'TimeoutError' }), 'timeout'], [new Error('fetch failed secret'), 'network']]) {
    const blocked = createBilibiliProfileReader({ fetcher: async () => { throw error; } });
    await assert.rejects(blocked.read('689985040'), failure => { assert.equal(failure.diagnostic.fetchErrorReason, expected); assert.equal(JSON.stringify(failure.diagnostic).includes('secret'), false); return true; });
  }
});

test('WBI uses fresh nav keys for verification and transmits the exact signed URL', async () => {
  let clock = 1702204169000, navCount = 0; const calls = [];
  const nav = () => ({ code: -101, message: '未登录', data: { wbi_img: {
    img_url: `https://i0.hdslb.com/bfs/wbi/${navCount === 1 ? '7cd084941338484aae1ad9425b84077c' : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}.png`,
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  } } });
  let currentKeys;
  const reader = createBilibiliProfileReader({ now: () => clock, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/nav')) { navCount++; const data = nav(); currentKeys = deriveWbiKeys(data); clock += 2500; return Response.json(data); }
    const parsed = new URL(url), query = parsed.search.slice(1).replace(/&w_rid=[a-f\d]{32}$/, '');
    assert.equal(parsed.searchParams.get('w_rid'), createHash('md5').update(query + currentKeys.mixin).digest('hex'));
    assert.equal(parsed.searchParams.get('mid'), '689985040'); assert.equal(parsed.searchParams.get('wts'), String(Math.floor(clock / 1000)));
    assert.deepEqual([...parsed.searchParams.keys()], ['mid', 'wts', 'w_rid']);
    return Response.json({ code: 0, data: { ...fixture().data.card, level: 5 } });
  } });
  for (let i = 0; i < 2; i++) { const profile = await reader.read('689985040', { mode: 'verify-signature', source: 'wbi' }); assert.equal(profile.level, 5); assert.equal(profile.followers, null); }
  assert.equal(navCount, 2); assert.equal(calls.length, 4);
  for (const { init } of calls) { assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.authorization, undefined); assert.equal(init.cache, 'no-store'); }
});

test('a blocked WBI nav stops before the signed profile request; malformed keys fail closed', async () => {
  for (const nav of [new Response('blocked', { status: 412, headers: { 'content-type': 'text/html' } }), Response.json({ code: -101, data: { wbi_img: {} } })]) {
    let count = 0;
    const reader = createBilibiliProfileReader({ fetcher: async () => { count++; return nav; } });
    await assert.rejects(reader.read('689985040', { mode: 'verify-signature', source: 'wbi' }));
    assert.equal(count, 1);
  }
});

test('follower synchronization is separate from ownership and checks returned UID', async () => {
  const reader = createBilibiliProfileReader({ fetcher: async () => Response.json({ code: 0, data: { mid: 689985040, follower: 418 } }) });
  assert.equal((await reader.readFollowers('689985040')).followers, 418);
  const wrong = createBilibiliProfileReader({ fetcher: async () => Response.json({ code: 0, data: { mid: 1, follower: 418 } }) });
  await assert.rejects(wrong.readFollowers('689985040'), { status: 502 });
});

test('actual Worker runtime accepts the profile request and rejects the former incompatible options', async t => {
  const files = ['bilibili-profile.mjs', 'bilibili-wbi.mjs'];
  let outbound = 0;
  const worker = `import {createBilibiliProfileReader} from './bilibili-profile.mjs';
    export default {async fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/current'){ const profile=await createBilibiliProfileReader().read('689985040',{mode:'verify-signature'}); return Response.json({uid:profile.uid}); }
      try{await fetch('https://api.bilibili.com/x/web-interface/card?mid=689985040',path==='/old-redirect'?{redirect:'error'}:{redirect:'manual',cache:'no-store',cf:{cacheTtl:0}});return Response.json({unexpected:true});}
      catch(error){return Response.json({name:error.name,message:error.message});}
    }};`;
  const mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], modulesRoot: '/',
    modules: [{ type: 'ESModule', path: '/index.mjs', contents: worker }, ...await Promise.all(files.map(async file => ({ type: 'ESModule', path: '/' + file, contents: await readFile(new URL('../src/' + file, import.meta.url), 'utf8') })))],
    outboundService: async request => { outbound++; assert.equal(request.headers.get('cookie'), null); return Response.json(fixture()); }
  }));
  t.after(() => mf.dispose());
  assert.deepEqual(await (await mf.dispatchFetch('https://test.example/current')).json(), { uid: '689985040' });
  assert.equal(outbound, 1);
  const oldRedirect = await (await mf.dispatchFetch('https://test.example/old-redirect')).json();
  assert.equal(oldRedirect.name, 'TypeError'); assert.match(oldRedirect.message, /Invalid redirect value/);
  const oldCache = await (await mf.dispatchFetch('https://test.example/old-cache')).json();
  assert.equal(oldCache.name, 'TypeError'); assert.match(oldCache.message, /not compatible/);
  assert.equal(outbound, 1);
});
test('upstream propagation is not replaced with fabricated fresh data', async () => {
  const old = fixture();
  assert.equal((await readBilibiliProfile('689985040', async () => Response.json(old))).signature, old.data.card.sign);
  const missingStats = fixture(); delete missingStats.data.card.level_info; delete missingStats.data.follower; missingStats.data.card.face = 'https://evil.test/a.jpg';
  const profile = await readBilibiliProfile('689985040', async () => Response.json(missingStats));
  assert.equal(profile.level, null); assert.equal(profile.followers, null); assert.equal(profile.avatar, null);
});
