import { describe, expect, it } from 'vitest';

import { searchCache, tokenize } from './search.js';
import { SEED_CHUNKS, SEED_DOCUMENTS } from './seed.js';

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('Hot-Work permit procedure')).toEqual(['hot', 'work', 'permit', 'procedure']);
  });

  it('drops stopwords and length-1 tokens', () => {
    expect(tokenize('How do I bypass the ESD?')).toEqual(['do', 'bypass', 'esd']);
  });

  it('returns [] for empty / pure-punctuation queries', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('searchCache', () => {
  it('returns the hot-work permit chunks for the canonical offline query', () => {
    const hits = searchCache('show me hot-work permit procedure', SEED_DOCUMENTS, SEED_CHUNKS);
    expect(hits.length).toBeGreaterThan(0);
    // The top hit must be a hot-work clause - that's the offline DoD.
    expect(hits[0]!.document.document_id).toBe('SOP-HOTWORK-001');
    expect(hits[0]!.matched_terms).toContain('hot');
    expect(hits[0]!.matched_terms).toContain('work');
    expect(hits[0]!.matched_terms).toContain('permit');
  });

  it('weights title hits over body-only hits', () => {
    const hits = searchCache('hot-work permit', SEED_DOCUMENTS, SEED_CHUNKS);
    // Title carries "Hot-work permit procedure" - every hot-work chunk
    // gets the title bonus, so all three hot-work chunks outrank the
    // single body-only mention in KICK's "shut-in" clause.
    expect(hits.every((h) => h.document.document_id === 'SOP-HOTWORK-001')).toBe(true);
  });

  it('weights clause-heading hits when the query mentions the clause', () => {
    const hits = searchCache('shut-in procedure', SEED_DOCUMENTS, SEED_CHUNKS);
    const topClauses = hits.slice(0, 2).map((h) => h.chunk.clause);
    expect(topClauses).toContain('2.2 Shut-in');
  });

  it('returns [] when nothing matches', () => {
    expect(searchCache('crankshaft alignment', SEED_DOCUMENTS, SEED_CHUNKS)).toEqual([]);
  });

  it('respects limit and minScore', () => {
    const allHits = searchCache('permit', SEED_DOCUMENTS, SEED_CHUNKS, {
      limit: 100,
      minScore: 1,
    });
    const limited = searchCache('permit', SEED_DOCUMENTS, SEED_CHUNKS, {
      limit: 1,
      minScore: 1,
    });
    expect(limited.length).toBe(1);
    expect(limited[0]).toEqual(allHits[0]);

    // Raising minScore drops body-only matches with no title hit.
    const strict = searchCache('isolation', SEED_DOCUMENTS, SEED_CHUNKS, {
      limit: 10,
      minScore: 4,
    });
    for (const hit of strict) {
      expect(hit.score).toBeGreaterThanOrEqual(4);
    }
  });
});
