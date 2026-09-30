import { capacityReport, generateCandidates, rankCandidate, unrankCandidate } from '../src/bilibili/encoder.mjs';
import { LITERARY_LEXICON } from '../src/bilibili/lexicon.mjs';

// This reproducible report is an inspection tool. Approval is never inferred from running it.
const samples = ['0123456789abcdef0123', '9ca81b7ef95d018465fc', 'ffffffffffffffffffff'].map(nonce => ({ nonce, candidates: generateCandidates(nonce) }));
for (const sample of samples) for (const candidate of sample.candidates) {
  if (unrankCandidate(candidate.index, rankCandidate(candidate.index, candidate.text)) !== candidate.text) throw new Error('Round-trip failed');
}
process.stdout.write(`${JSON.stringify({ ...capacityReport(), samples, exclusions: LITERARY_LEXICON.exclusions, reviewableWordGroups: LITERARY_LEXICON.slots.map(slot => ({ slot: slot.name, groups: slot.entries.map(entry => ({ phrase: entry.word, tags: entry.tags })) })) }, null, 2)}\n`);
