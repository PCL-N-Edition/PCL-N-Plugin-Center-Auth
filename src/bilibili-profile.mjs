import { deriveWbiKeys, buildWbiProfileUrl } from './bilibili-wbi.mjs';

const MAX_BODY = 131072;
const BLOCK_CODES = new Set([-412, -352]);
const MESSAGE_ALLOWLIST = new Set(['0', 'OK', 'success', '请求被拦截', '请求被拒绝', '请求被风控', '请求被禁止', '账号不存在', '用户不存在', '未登录', '访问权限不足', '请求错误']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'TimeoutError', 'AbortError', 'NetworkError']);

export class BilibiliProfileError extends Error {
  constructor(status, message, diagnostic, retryAfterSeconds) {
    super(message);
    this.name = 'BilibiliProfileError';
    this.status = status;
    this.diagnostic = diagnostic;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
const fail = (status, message, diagnostic, retryAfterSeconds) => { throw new BilibiliProfileError(status, message, diagnostic, retryAfterSeconds); };
export function bilibiliUid(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) fail(422, '请输入有效的B站 UID');
  return value;
}

function mediaType(response) {
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : null;
}
function safeMessage(value) {
  if (typeof value !== 'string') return null;
  return MESSAGE_ALLOWLIST.has(value) || /^request(?: (?:was|has been))? (?:blocked|forbidden|denied|rejected)[.!]?$/i.test(value) ? value : null;
}
function fetchFailure(error) {
  const name = ERROR_NAMES.has(error?.name) ? error.name : 'Error';
  // Classify a runtime configuration failure without exposing its URL or headers.
  const message = typeof error?.message === 'string' ? error.message : '';
  const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout'
    : /(?:unsupported|not implemented|invalid|not compatible).{0,80}cache|cache.{0,80}(?:unsupported|not implemented|invalid|not compatible)/i.test(message) ? 'cache_configuration'
    : /(?:unsupported|not implemented|invalid).{0,80}redirect|redirect.{0,80}(?:unsupported|not implemented|invalid)/i.test(message) ? 'redirect_configuration'
    : /network|connect|socket|fetch failed/i.test(message) ? 'network' : 'unknown';
  return { fetchErrorName: name, fetchErrorReason: reason };
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: 0, text: '', tooLarge: false };
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > MAX_BODY) { await reader.cancel(); return { bytes, text: null, tooLarge: true }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return { bytes, text: new TextDecoder().decode(all), tooLarge: false };
}

function validatedProfile(uid, card, level, followers, diagnostic, now) {
  const returnedUid = typeof card?.mid === 'string' ? card.mid : Number.isSafeInteger(card?.mid) ? String(card.mid) : null;
  if (!card || returnedUid !== uid || typeof card.sign !== 'string' || card.sign.length > 512) fail(502, 'B站资料不完整，无法验证账户', diagnostic);
  const avatar = typeof card.face === 'string' && /^https:\/\/[a-zA-Z0-9.-]+\.hdslb\.com\//.test(card.face) ? card.face : null;
  return Object.freeze({
    uid, name: typeof card.name === 'string' ? card.name.slice(0, 128) : null, avatar, signature: card.sign,
    level: Number.isInteger(level) && level >= 0 && level <= 6 ? level : null,
    followers: Number.isSafeInteger(followers) && followers >= 0 ? followers : null,
    fetchedAt: new Date(now).toISOString()
  });
}

export function createBilibiliProfileReader({ fetcher = fetch, now = Date.now, displayTtlMs = 60000, breakerMs = 600000, maxProfiles = 128, onDiagnostic } = {}) {
  if (!Number.isSafeInteger(displayTtlMs) || displayTtlMs < 0 || displayTtlMs > 300000 || !Number.isSafeInteger(breakerMs) || breakerMs < 1000 || breakerMs > 3600000 || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 1000) throw new TypeError('Invalid Bilibili reader limits');
  const inFlight = new Map(), displayCache = new Map();
  let blockedUntil = 0, lastBlock = null, keys = null, keysUntil = 0, keysInFlight = null;
  function report(diagnostic) {
    const safe = Object.freeze({ ...diagnostic });
    // Diagnostic handlers cannot affect verification or cause retries.
    try { onDiagnostic?.(safe); } catch { /* Caller owns diagnostic delivery. */ }
    return safe;
  }
  function checkBreaker() {
    if (now() < blockedUntil) fail(503, 'B站暂时限制资料读取，请稍后再试', lastBlock, Math.ceil((blockedUntil - now()) / 1000));
  }
  function tripBreaker(diagnostic, response) {
    const seconds = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? Math.max(breakerMs, Math.min(seconds * 1000, 3600000)) : breakerMs;
    blockedUntil = Math.max(blockedUntil, now() + delay);
    lastBlock = diagnostic;
    fail(503, 'B站暂时限制资料读取，请稍后再试', diagnostic, Math.ceil(delay / 1000));
  }
  async function requestJson(endpoint, url, uid, allowedCodes = [0]) {
    checkBreaker();
    let response;
    try {
      response = await fetcher(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), cache: 'no-store',
        headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store', 'user-agent': 'Nexa-Account-Verification/1.0', ...(uid ? { referer: `https://space.bilibili.com/${uid}` } : {}) }
      });
    } catch (error) {
      const diagnostic = report({ endpoint, httpStatus: null, contentType: null, businessCode: null, businessMessage: null, ...fetchFailure(error) });
      fail(502, diagnostic.fetchErrorReason === 'timeout' ? '读取B站资料超时，请稍后再试' : '暂时无法读取B站资料，请稍后重试', diagnostic);
    }
    let body;
    try { body = await boundedBody(response); }
    catch (error) {
      const diagnostic = report({ endpoint, httpStatus: response.status, contentType: mediaType(response), businessCode: null, businessMessage: null, ...fetchFailure(error) });
      if (response.status === 412 || response.status === 429) tripBreaker(diagnostic, response);
      fail(502, 'B站资料响应读取失败，请稍后重试', diagnostic);
    }
    const contentType = mediaType(response);
    let payload = null;
    if (!body.tooLarge && contentType && /(?:\/json|\+json)$/.test(contentType)) {
      try { payload = JSON.parse(body.text); } catch { /* Report format failure separately. */ }
    }
    const businessMessage = safeMessage(payload?.message);
    const diagnostic = report({ endpoint, httpStatus: response.status, contentType, bodyBytes: body.bytes, bodyTooLarge: body.tooLarge, businessCode: Number.isSafeInteger(payload?.code) ? payload.code : null, businessMessage, businessMessageRedacted: typeof payload?.message === 'string' && businessMessage === null, fetchErrorName: null, fetchErrorReason: null });
    if (response.status === 412 || response.status === 429 || BLOCK_CODES.has(payload?.code)) tripBreaker(diagnostic, response);
    if (!response.ok) fail(502, response.status >= 300 && response.status < 400 ? 'B站资料接口返回跳转，无法验证账户' : 'B站资料服务暂时不可用，请稍后重试', diagnostic);
    if (body.tooLarge) fail(502, 'B站资料响应过大，无法验证账户', diagnostic);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(502, 'B站资料响应不是有效JSON，无法验证账户', diagnostic);
    if (payload.code === -404) fail(404, '未找到该B站账户', diagnostic);
    if (!allowedCodes.includes(payload.code)) fail(503, 'B站未返回有效资料，请稍后重试', diagnostic);
    return { payload, diagnostic };
  }
  async function freshKeys(force) {
    checkBreaker();
    if (keysInFlight) return keysInFlight;
    if (!force && keys && now() < keysUntil) return keys;
    keysInFlight = (async () => {
      const { payload, diagnostic } = await requestJson('wbi-nav', 'https://api.bilibili.com/x/web-interface/nav', null, [0, -101]);
      let next;
      try { next = deriveWbiKeys(payload); }
      catch { fail(502, 'B站未返回有效WBI参数，无法验证账户', diagnostic); }
      keys = next; keysUntil = now() + 30000;
      return next;
    })();
    try { return await keysInFlight; } finally { keysInFlight = null; }
  }
  async function load(uid, source, mode) {
    if (source === 'card') {
      const url = `https://api.bilibili.com/x/web-interface/card?mid=${uid}`;
      const { payload, diagnostic } = await requestJson('card', url, uid);
      return validatedProfile(uid, payload.data?.card, payload.data?.card?.level_info?.current_level, payload.data?.follower, diagnostic, now());
    }
    const currentKeys = await freshKeys(mode === 'verify-signature');
    const url = buildWbiProfileUrl(uid, currentKeys, Math.floor(now() / 1000));
    const { payload, diagnostic } = await requestJson('wbi-profile', url, uid);
    // Ownership proof is independent of follower synchronization.
    return validatedProfile(uid, payload.data, payload.data?.level, null, diagnostic, now());
  }
  async function read(uid, { mode = 'display', source = 'card' } = {}) {
    bilibiliUid(uid);
    if (!['display', 'verify-signature'].includes(mode) || !['card', 'wbi'].includes(source)) throw new TypeError('Invalid Bilibili profile read mode');
    const cacheKey = `${source}:${uid}`;
    if (mode === 'display') {
      const hit = displayCache.get(cacheKey);
      if (hit && now() < hit.until) return hit.profile;
    }
    checkBreaker();
    const flightKey = `${mode}:${cacheKey}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const work = (async () => {
      const profile = await load(uid, source, mode);
      if (displayTtlMs) {
        displayCache.delete(cacheKey);
        while (displayCache.size >= maxProfiles) displayCache.delete(displayCache.keys().next().value);
        displayCache.set(cacheKey, { profile, until: now() + displayTtlMs });
      }
      return profile;
    })();
    inFlight.set(flightKey, work);
    try { return await work; } finally { if (inFlight.get(flightKey) === work) inFlight.delete(flightKey); }
  }
  async function readFollowers(uid) {
    bilibiliUid(uid); checkBreaker();
    const flightKey = `followers:${uid}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const work = (async () => {
      const { payload, diagnostic } = await requestJson('relation', `https://api.bilibili.com/x/relation/stat?vmid=${uid}`, uid);
      const data = payload.data;
      const returnedUid = typeof data?.mid === 'string' ? data.mid : Number.isSafeInteger(data?.mid) ? String(data.mid) : null;
      if (returnedUid !== uid || !Number.isSafeInteger(data?.follower) || data.follower < 0) fail(502, 'B站未返回有效粉丝资料', diagnostic);
      return Object.freeze({ uid, followers: data.follower, fetchedAt: new Date(now()).toISOString() });
    })();
    inFlight.set(flightKey, work);
    try { return await work; } finally { if (inFlight.get(flightKey) === work) inFlight.delete(flightKey); }
  }
  return Object.freeze({ read, readFollowers });
}

const readers = new WeakMap();
export async function readBilibiliProfile(uid, fetcher = fetch, options = {}) {
  let reader = readers.get(fetcher);
  if (!reader) { reader = createBilibiliProfileReader({ fetcher }); readers.set(fetcher, reader); }
  return reader.read(uid, options);
}
