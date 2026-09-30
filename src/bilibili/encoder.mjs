import { LITERARY_LEXICON } from './lexicon.mjs';
import { canonicalText, compileClauseGrammar } from './encoder-compiler.mjs';

export const ENCODER_VERSION = LITERARY_LEXICON.version;
export const NONCE_BITS = 80;
export const NONCE_LIMIT = 1n << 80n;
export const normalizeSignature = canonicalText;
const grammar = compileClauseGrammar(LITERARY_LEXICON);
if (LITERARY_LEXICON.clauseCount !== 3 || LITERARY_LEXICON.spacePrefixes.length !== 3
  || new Set(LITERARY_LEXICON.spacePrefixes.map(normalizeSignature)).size !== 3) throw new Error('The three fixed candidate prefixes must be distinct');
const FULL_CLAUSE_CAPACITY = grammar.capacity();
const SPACE_CAPACITIES = LITERARY_LEXICON.spacePrefixes.map(prefix => grammar.capacity(prefix) * FULL_CLAUSE_CAPACITY ** 2n);
// Odd multipliers are bijections modulo 2^80. These constants are part of the version.
const NONCE_MULTIPLIERS = [1n, 0x9e3779b97f4a7c15bd2dn, 0xd6e8feb86659fd93ab5dn];
const NONCE_OFFSETS = [0n, 0x243f6a8885a308d31319n, 0x13198a2e03707344a409n];
if (SPACE_CAPACITIES.some(capacity => capacity < NONCE_LIMIT)) throw new Error('Each Bilibili candidate space must contain at least 2^80 legal sentences');
const SENTENCE_LENGTH = grammar.clauseWidth * 3 + 3;
if (SENTENCE_LENGTH < LITERARY_LEXICON.minLength || SENTENCE_LENGTH > LITERARY_LEXICON.maxLength) throw new Error('Signature length outside contract');

export function capacityReport() {
  return {
    encoderVersion: ENCODER_VERSION,
    reviewStatus: LITERARY_LEXICON.reviewStatus,
    nonceBits: NONCE_BITS,
    nonceLimit: NONCE_LIMIT.toString(),
    unicodeLength: SENTENCE_LENGTH,
    clauseCount: 3,
    fullClauseCapacity: FULL_CLAUSE_CAPACITY.toString(),
    slots: grammar.slotSizes,
    spaces: SPACE_CAPACITIES.map((capacity, index) => ({ index, prefix: LITERARY_LEXICON.spacePrefixes[index], capacity: capacity.toString(), entropyBitsFloor: capacity.toString(2).length - 1, atLeast80Bits: capacity >= NONCE_LIMIT })),
    totalLegalCapacity: SPACE_CAPACITIES.reduce((sum, capacity) => sum + capacity, 0n).toString(),
    reachableCapacity: (3n * NONCE_LIMIT).toString(),
    nonceMapping: 'odd affine permutation modulo 2^80, then floor(permutedNonce * legalSpaceCapacity / 2^80)',
    normalization: 'NFC; trim outer whitespace; reject control/format/line-separator characters; exact visible punctuation',
    memoStates: grammar.memoStateCount(),
  };
}

function checkSpace(index) {
  if (!Number.isInteger(index) || index < 0 || index > 2) throw new RangeError('Candidate index must be 0, 1 or 2');
}

export function unrankCandidate(index, rank) {
  checkSpace(index);
  if (typeof rank !== 'bigint' || rank < 0n || rank >= SPACE_CAPACITIES[index]) throw new RangeError('Candidate rank outside legal subspace');
  const square = FULL_CLAUSE_CAPACITY ** 2n;
  const first = rank / square, second = (rank / FULL_CLAUSE_CAPACITY) % FULL_CLAUSE_CAPACITY, third = rank % FULL_CLAUSE_CAPACITY;
  return `${grammar.unrank(first, LITERARY_LEXICON.spacePrefixes[index])}，${grammar.unrank(second)}，${grammar.unrank(third)}。`;
}

export function rankCandidate(index, value) {
  checkSpace(index);
  const text = normalizeSignature(value);
  if (text !== value || Array.from(text).length !== SENTENCE_LENGTH || !text.endsWith('。')) throw new Error('Noncanonical candidate');
  const clauses = text.slice(0, -1).split('，');
  if (clauses.length !== 3) throw new Error('Candidate must have exactly three clauses');
  return grammar.rank(clauses[0], LITERARY_LEXICON.spacePrefixes[index]) * FULL_CLAUSE_CAPACITY ** 2n
    + grammar.rank(clauses[1]) * FULL_CLAUSE_CAPACITY + grammar.rank(clauses[2]);
}

export function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateCandidates(nonceHex) {
  if (typeof nonceHex !== 'string' || !/^[\da-f]{20}$/i.test(nonceHex)) throw new TypeError('Nonce must contain exactly 80 bits as 20 hexadecimal digits');
  const nonce = BigInt(`0x${nonceHex}`);
  return LITERARY_LEXICON.spacePrefixes.map((_, index) => {
    const permuted = (nonce * NONCE_MULTIPLIERS[index] + NONCE_OFFSETS[index]) % NONCE_LIMIT;
    const rank = permuted * SPACE_CAPACITIES[index] / NONCE_LIMIT;
    return { index, text: unrankCandidate(index, rank) };
  });
}

export function assertProductionLexicon(reviewedVersion) {
  if (reviewedVersion !== ENCODER_VERSION) throw new Error('The exact signature lexicon version has not been approved for production');
}
