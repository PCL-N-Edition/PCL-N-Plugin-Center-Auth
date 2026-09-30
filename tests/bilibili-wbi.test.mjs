import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveWbiKeys, signWbiParameters, buildWbiProfileUrl } from '../src/bilibili-wbi.mjs';

const nav = (code = -101) => ({ code, data: { wbi_img: {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
} } });

test('WBI public nav keys and canonical checksum match the known protocol vector', () => {
  const keys = deriveWbiKeys(nav());
  assert.equal(keys.mixin, 'ea1db124af3c7062474693fa704f4ff8');
  const signed = signWbiParameters({ foo: '114', bar: '514', baz: '1919810' }, keys, 1702204169);
  assert.equal(signed.query, 'bar=514&baz=1919810&foo=114&wts=1702204169');
  assert.equal(signed.signature, '6149fdadf571698ca7e6a567265cd0ee');
  assert.deepEqual(deriveWbiKeys(nav(0)), keys);
});

test('actual profile URL contains precisely the parameters that were signed', () => {
  const keys = deriveWbiKeys(nav());
  const url = new URL(buildWbiProfileUrl('689985040', keys, 1702204169));
  assert.equal(url.origin + url.pathname, 'https://api.bilibili.com/x/space/wbi/acc/info');
  assert.equal(url.searchParams.get('mid'), '689985040');
  assert.equal(url.searchParams.get('wts'), '1702204169');
  assert.deepEqual([...url.searchParams.keys()], ['mid', 'wts', 'w_rid']);
  const actualUnsignedQuery = url.search.slice(1).replace(/&w_rid=[a-f\d]{32}$/, '');
  assert.equal(url.searchParams.get('w_rid'), createHash('md5').update(actualUnsignedQuery + keys.mixin).digest('hex'));
  assert.equal(url.searchParams.has('_nexa'), false);
});

test('unwanted characters are removed before encoding and cannot produce signed/sent drift', () => {
  const signed = signWbiParameters({ unicode: '青 蓝+海', foo: "a!'()*b", alpha: '~_' }, deriveWbiKeys(nav()), 1702204169);
  assert.equal(signed.query, 'alpha=~_&foo=ab&unicode=%E9%9D%92+%E8%93%9D%2B%E6%B5%B7&wts=1702204169');
  assert.equal(new URLSearchParams(signed.query).get('foo'), 'ab');
  assert.equal(new URLSearchParams(signed.query).get('unicode'), '青 蓝+海');
  assert.throws(() => signWbiParameters({ w_rid: 'forged' }, deriveWbiKeys(nav()), 1), TypeError);
  assert.throws(() => signWbiParameters({ wts: 'old' }, deriveWbiKeys(nav()), 1), TypeError);
});

test('invalid keys, credentials in key URLs, input and timestamps fail before network use', () => {
  for (const value of [null, {}, nav(-400), { code: 0, data: { wbi_img: { img_url: 'https://evil.test/a.png', sub_url: nav().data.wbi_img.sub_url } } },
    { code: 0, data: { wbi_img: { img_url: 'https://user:secret@i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: nav().data.wbi_img.sub_url } } }]) {
    assert.throws(() => deriveWbiKeys(value), TypeError);
  }
  for (const timestamp of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => signWbiParameters({ mid: '1' }, deriveWbiKeys(nav()), timestamp), TypeError);
  for (const uid of ['0', '001', '1&mid=2', 123]) assert.throws(() => buildWbiProfileUrl(uid, deriveWbiKeys(nav()), 1), TypeError);
});
