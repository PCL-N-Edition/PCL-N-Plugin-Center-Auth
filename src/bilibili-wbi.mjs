import { createHash } from 'node:crypto';

// WBI is an upstream protocol checksum, never an authentication secret.
const MIXIN_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13
];
const unwanted = /[!'()*]/g;
const encode = value => encodeURIComponent(value).replace(/%20/g, '+');

function imageKey(value) {
  if (typeof value !== 'string') throw new TypeError('Missing WBI image URL');
  const url = new URL(value);
  const match = /\/([a-f\d]{32})\.(?:png|webp)$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.hdslb.com') || !match) throw new TypeError('Invalid WBI image URL');
  return match[1];
}

export function deriveWbiKeys(payload) {
  // A public nav response can be -101 (not logged in) and still contain keys.
  if (payload?.code !== 0 && payload?.code !== -101) throw new TypeError('Invalid WBI key response');
  const image = imageKey(payload.data?.wbi_img?.img_url);
  const sub = imageKey(payload.data?.wbi_img?.sub_url);
  const joined = image + sub;
  return Object.freeze({ image, sub, mixin: MIXIN_ORDER.map(index => joined[index]).join('') });
}

export function signWbiParameters(params, keys, timestamp = Math.floor(Date.now() / 1000)) {
  if (!keys || !/^[a-f\d]{32}$/.test(keys.mixin ?? '')) throw new TypeError('Invalid WBI mixin key');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new TypeError('Invalid WBI timestamp');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Invalid WBI parameters');
  const clean = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-zA-Z_][a-zA-Z\d_]*$/.test(key) || key === 'w_rid' || key === 'wts') throw new TypeError('Invalid WBI parameter name');
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new TypeError('Invalid WBI parameter value');
    clean[key] = String(value).replace(unwanted, '');
  }
  clean.wts = String(timestamp);
  const query = Object.keys(clean).sort().map(key => `${encode(key)}=${encode(clean[key])}`).join('&');
  const signature = createHash('md5').update(query + keys.mixin, 'utf8').digest('hex');
  return Object.freeze({ parameters: Object.freeze({ ...clean }), query, signature });
}

export function buildWbiProfileUrl(uid, keys, timestamp = Math.floor(Date.now() / 1000)) {
  if (typeof uid !== 'string' || !/^[1-9]\d{0,19}$/.test(uid)) throw new TypeError('Invalid Bilibili UID');
  const signed = signWbiParameters({ mid: uid }, keys, timestamp);
  // Send exactly what was hashed; do not serialize or append parameters afterwards.
  return `https://api.bilibili.com/x/space/wbi/acc/info?${signed.query}&w_rid=${signed.signature}`;
}
