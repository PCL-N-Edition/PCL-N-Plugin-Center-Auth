import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileClauseGrammar } from '../src/bilibili/encoder-compiler.mjs';
import { LITERARY_LEXICON } from '../src/bilibili/lexicon.mjs';
import { ENCODER_VERSION, NONCE_LIMIT, capacityReport, generateCandidates, generateNonce, normalizeSignature, rankCandidate, unrankCandidate, assertProductionLexicon } from '../src/bilibili/encoder.mjs';

const word = (text, ...tags) => ({ word: text, tags });

test('tiny constrained grammar is exhaustively injective and rank/unrank agrees with independent enumeration', () => {
  const lexicon = {
    slots: [
      { name: 'time', entries: [word('晨间', 'day'), word('夜间', 'night')] },
      { name: 'style', entries: [word('轻轻'), word('乘月', 'night')] },
      { name: 'scene', entries: [word('苍翠', 'green'), word('寂静')] },
      { name: 'place', entries: [word('古城', 'built'), word('山林')] },
    ],
    exclusions: [
      { left: 'time', leftTag: 'day', right: 'style', rightTag: 'night' },
      { left: 'scene', leftTag: 'green', right: 'place', rightTag: 'built' },
    ],
  };
  const expected = [];
  for (const time of lexicon.slots[0].entries) for (const style of lexicon.slots[1].entries) for (const scene of lexicon.slots[2].entries) for (const place of lexicon.slots[3].entries) {
    if (time.tags.includes('day') && style.tags.includes('night')) continue;
    if (scene.tags.includes('green') && place.tags.includes('built')) continue;
    expected.push(time.word + style.word + scene.word + place.word);
  }
  const grammar = compileClauseGrammar(lexicon);
  assert.equal(grammar.capacity(), 9n);
  assert.equal(new Set(expected).size, expected.length);
  expected.forEach((text, index) => { assert.equal(grammar.unrank(BigInt(index)), text); assert.equal(grammar.rank(text), BigInt(index)); });
  assert.equal(grammar.capacity('晨间'), 3n);
  assert.equal(grammar.capacity('夜间'), 6n);
  for (let rank = 0n; rank < 3n; rank++) assert.equal(grammar.rank(grammar.unrank(rank, '晨间'), '晨间'), rank);
  assert.throws(() => grammar.rank('晨间乘月寂静古城'), /legal grammar/);
  assert.throws(() => grammar.unrank(9n), RangeError);
  assert.throws(() => grammar.unrank(-1n), RangeError);
});

test('unicode width is measured in code points, and ambiguous or noncanonical dictionaries are rejected', () => {
  const grammar = compileClauseGrammar({ slots: [{ name: 'x', entries: [word('😀甲'), word('乙丙')] }] });
  assert.equal(grammar.clauseWidth, 2);
  assert.equal(grammar.unrank(0n), '😀甲');
  assert.equal(grammar.rank('😀甲'), 0n);
  assert.throws(() => compileClauseGrammar({ slots: [{ name: 'x', entries: [word('重复'), word('重复')] }] }), /Duplicate/);
  assert.throws(() => compileClauseGrammar({ slots: [{ name: 'x', entries: [word('é甲'), word('e\u0301甲')] }] }), /Noncanonical/);
  assert.throws(() => compileClauseGrammar({ slots: [{ name: 'x', entries: [word('一个'), word('三个字')] }] }), /Variable width/);
  assert.throws(() => compileClauseGrammar({ slots: [{ name: 'x', entries: [word('甲\u200b')] }] }), /control/);
});

test('normalization is fixed; invisibles, line breaks, punctuation variants never add codes', () => {
  assert.equal(normalizeSignature('  e\u0301  '), 'é');
  for (const separator of ['\u200b', '\u200d', '\u2060', '\u202e', '\ufeff', '\n', '\r', '\t', '\u2028']) assert.throws(() => normalizeSignature(`甲${separator}乙`), /control/);
  const candidate = generateCandidates('00000000000000000000')[0].text;
  assert.equal(normalizeSignature(` ${candidate} `), candidate);
  assert.throws(() => rankCandidate(0, candidate.replaceAll('，', ',')), /Noncanonical|exactly three clauses/);
  assert.throws(() => rankCandidate(0, candidate.replace('。', '．')), /Noncanonical/);
});

test('actual lexicon capacity is independently counted, including every semantic exclusion', () => {
  const [times, people, manners, actions, scenes, places] = LITERARY_LEXICON.slots.map(slot => slot.entries);
  let scenePlacePairs = 0n;
  for (const scene of scenes) for (const place of places) {
    if (scene.tags.includes('green') && (place.tags.includes('built') || place.tags.includes('bare'))) continue;
    if (scene.tags.includes('expansive') && place.tags.includes('confined')) continue;
    scenePlacePairs++;
  }
  const perTime = new Map();
  for (const time of times) {
    let prefixes = 0n;
    for (const person of people) for (const manner of manners) for (const action of actions) {
      if (time.tags.includes('day') && manner.tags.includes('night')) continue;
      if (time.tags.includes('summer') && manner.tags.includes('snow')) continue;
      if (person.tags.includes('elder') && action.tags.includes('rush')) continue;
      if (manner.tags.includes('tread') && action.tags.includes('tread')) continue;
      prefixes++;
    }
    perTime.set(time.word, prefixes * scenePlacePairs);
  }
  const full = [...perTime.values()].reduce((sum, count) => sum + count, 0n);
  const report = capacityReport();
  assert.equal(BigInt(report.fullClauseCapacity), full);
  report.spaces.forEach(space => { assert.equal(BigInt(space.capacity), perTime.get(space.prefix) * full ** 2n); assert.ok(BigInt(space.capacity) >= NONCE_LIMIT); });
  assert.equal(BigInt(report.reachableCapacity), 3n * NONCE_LIMIT);
  assert.equal(report.unicodeLength, 39);
  assert.equal(report.reviewStatus, 'draft');
  assert.throws(() => assertProductionLexicon(undefined), /not been approved/);
  assert.throws(() => assertProductionLexicon('some-older-version'), /not been approved/);
  assert.doesNotThrow(() => assertProductionLexicon(ENCODER_VERSION));
});

test('rank/unrank handles each legal-space boundary and rejects crossing into another space', () => {
  capacityReport().spaces.forEach(space => {
    const last = BigInt(space.capacity) - 1n;
    for (const rank of [0n, 1n, NONCE_LIMIT - 1n, NONCE_LIMIT, last]) {
      const text = unrankCandidate(space.index, rank);
      assert.equal(rankCandidate(space.index, text), rank);
      assert.equal(Array.from(text).length, 39);
      assert.equal(text.split('，').length, 3);
      assert.throws(() => rankCandidate((space.index + 1) % 3, text), /legal grammar/);
    }
    assert.throws(() => unrankCandidate(space.index, last + 1n), RangeError);
  });
});

test('80-bit crypto nonces reproduce three distinct candidates; sampled encodings have no collisions', () => {
  const seen = new Set();
  const nonces = new Set(['00000000000000000000', '00000000000000000001', 'fffffffffffffffffffe', 'ffffffffffffffffffff']);
  while (nonces.size < 2048) { const nonce = generateNonce(); assert.match(nonce, /^[0-9a-f]{20}$/); nonces.add(nonce); }
  for (const nonce of nonces) {
    const candidates = generateCandidates(nonce);
    assert.deepEqual(candidates, generateCandidates(nonce));
    assert.deepEqual(candidates, generateCandidates(nonce.toUpperCase()));
    for (const { index, text } of candidates) {
      assert.ok(!seen.has(text), `Collision at ${nonce}, space ${index}`);
      seen.add(text);
      assert.equal(normalizeSignature(text), text);
      assert.equal(Array.from(text).length, 39);
      assert.equal(unrankCandidate(index, rankCandidate(index, text)), text);
    }
  }
  assert.equal(seen.size, nonces.size * 3);
  for (const invalid of ['0', '0'.repeat(19), '0'.repeat(21), 'z'.repeat(20), null]) assert.throws(() => generateCandidates(invalid), TypeError);
});
