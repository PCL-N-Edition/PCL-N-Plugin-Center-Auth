const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function canonicalText(value) {
  if (typeof value !== 'string') throw new TypeError('Signature must be a string');
  if (FORBIDDEN.test(value)) throw new TypeError('Signature contains a control, format or line separator');
  return value.normalize('NFC').trim();
}

const codepoints = value => Array.from(value);

/** Compile a fixed-width grammar, counting only branches allowed by semantic rules. */
export function compileClauseGrammar(lexicon) {
  const tagNames = [...new Set(lexicon.slots.flatMap(slot => slot.entries.flatMap(entry => entry.tags ?? [])))].sort();
  const tagBits = new Map(tagNames.map((tag, index) => [tag, 1n << BigInt(index)]));
  const names = lexicon.slots.map(slot => slot.name);
  if (new Set(names).size !== names.length || names.length === 0) throw new Error('Slot names must be unique');
  const slots = lexicon.slots.map(slot => {
    if (!slot.entries.length) throw new Error(`Empty slot: ${slot.name}`);
    const seen = new Set();
    const entries = slot.entries.map(entry => {
      const word = canonicalText(entry.word);
      if (word !== entry.word || /\s/u.test(word)) throw new Error(`Noncanonical phrase in ${slot.name}`);
      if ([lexicon.separator, lexicon.terminator].filter(Boolean).some(delimiter => word.includes(delimiter))) throw new Error(`Phrase contains a reserved delimiter in ${slot.name}`);
      if (seen.has(word)) throw new Error(`Duplicate or normalization collision in ${slot.name}: ${word}`);
      seen.add(word);
      return { word, mask: (entry.tags ?? []).reduce((mask, tag) => mask | tagBits.get(tag), 0n) };
    });
    const width = codepoints(entries[0].word).length;
    if (!width || entries.some(entry => codepoints(entry.word).length !== width)) throw new Error(`Variable width slot: ${slot.name}`);
    return { name: slot.name, width, entries, byWord: new Map(entries.map((entry, index) => [entry.word, index])) };
  });
  const rules = (lexicon.exclusions ?? []).map(rule => {
    const left = names.indexOf(rule.left), right = names.indexOf(rule.right);
    if (left < 0 || right <= left || !tagBits.has(rule.leftTag) || !tagBits.has(rule.rightTag)) throw new Error('Invalid exclusion rule');
    return { left, right, leftMask: tagBits.get(rule.leftTag), rightMask: tagBits.get(rule.rightTag) };
  });
  const lastUse = slots.map((_, index) => Math.max(index, ...rules.filter(rule => rule.left === index).map(rule => rule.right)));
  const relevantMasks = slots.map((_, index) => rules.filter(rule => rule.left === index).reduce((mask, rule) => mask | rule.leftMask, 0n));
  const memo = new Map();
  const initialState = slots.map(() => 0n);
  const allowed = (position, entry, state) => !rules.some(rule => rule.right === position && (state[rule.left] & rule.leftMask) !== 0n && (entry.mask & rule.rightMask) !== 0n);
  const advance = (position, entry, state) => state.map((mask, index) => {
    if (lastUse[index] < position + 1) return 0n;
    return index === position ? entry.mask & relevantMasks[index] : mask;
  });
  const countFrom = (position, state) => {
    if (position === slots.length) return 1n;
    const key = `${position}:${state.join(',')}`;
    if (memo.has(key)) return memo.get(key);
    let count = 0n;
    for (const entry of slots[position].entries) if (allowed(position, entry, state)) count += countFrom(position + 1, advance(position, entry, state));
    memo.set(key, count);
    return count;
  };
  const prefixOptions = fixedFirstWord => {
    if (fixedFirstWord === undefined) return slots[0].entries;
    const index = slots[0].byWord.get(fixedFirstWord);
    if (index === undefined) throw new Error('Unknown fixed prefix');
    return [slots[0].entries[index]];
  };
  const capacity = fixedFirstWord => prefixOptions(fixedFirstWord).reduce((count, entry) => count + countFrom(1, advance(0, entry, initialState)), 0n);
  function unrank(rank, fixedFirstWord) {
    if (typeof rank !== 'bigint' || rank < 0n || rank >= capacity(fixedFirstWord)) throw new RangeError('Rank outside legal grammar');
    let state = initialState, result = '';
    for (let position = 0; position < slots.length; position++) {
      const options = position === 0 ? prefixOptions(fixedFirstWord) : slots[position].entries;
      let selected;
      for (const entry of options) {
        if (!allowed(position, entry, state)) continue;
        const next = advance(position, entry, state), block = countFrom(position + 1, next);
        if (rank >= block) { rank -= block; continue; }
        selected = entry; state = next; result += entry.word; break;
      }
      if (!selected) throw new Error('Compiled grammar count mismatch');
    }
    return result;
  }
  function rank(value, fixedFirstWord) {
    const text = canonicalText(value), chars = codepoints(text);
    if (text !== value || chars.length !== slots.reduce((length, slot) => length + slot.width, 0)) throw new Error('Noncanonical clause');
    let offset = 0, state = initialState, result = 0n;
    for (let position = 0; position < slots.length; position++) {
      const slot = slots[position], word = chars.slice(offset, offset + slot.width).join(''); offset += slot.width;
      const options = position === 0 ? prefixOptions(fixedFirstWord) : slot.entries;
      let selected;
      for (const entry of options) {
        if (!allowed(position, entry, state)) continue;
        if (entry.word === word) { selected = entry; state = advance(position, entry, state); break; }
        result += countFrom(position + 1, advance(position, entry, state));
      }
      if (!selected) throw new Error('Phrase is not in the legal grammar');
    }
    return result;
  }
  return { capacity, rank, unrank, clauseWidth: slots.reduce((length, slot) => length + slot.width, 0), slotSizes: slots.map(slot => ({ name: slot.name, size: slot.entries.length })), memoStateCount: () => memo.size };
}
