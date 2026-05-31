/**
 * Offline search over the local SOP cache (pure TS).
 *
 * Phase-1 ranking is intentionally simple - substring matches scored
 * higher when they land in the title or a clause heading than when they
 * land mid-body. Real ranking lands when the backend tenant-snapshot
 * endpoint ships chunks with pre-computed BM25 scores; until then this
 * function keeps the offline path honest.
 *
 * The function is exported as pure data → pure data so the Vitest suite
 * can drive it directly without spinning up the SQLite database.
 */
import type { CachedChunk, CachedDocument, CachedHit } from './types.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i',
  'in', 'is', 'it', 'me', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'what', 'when', 'where', 'with',
]);

export interface SearchOptions {
  /** Hard cap on returned hits. Defaults to 5. */
  limit?: number;
  /** Drop hits with a score strictly below this. Defaults to 1. */
  minScore?: number;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function searchCache(
  query: string,
  documents: CachedDocument[],
  chunks: CachedChunk[],
  options: SearchOptions = {},
): CachedHit[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 1;
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const byDocumentId = new Map(documents.map((d) => [d.document_id, d]));
  const hits: CachedHit[] = [];

  for (const chunk of chunks) {
    const document = byDocumentId.get(chunk.document_id);
    if (!document) continue;

    const titleLower = document.title.toLowerCase();
    const clauseLower = (chunk.clause ?? '').toLowerCase();
    const textLower = chunk.text.toLowerCase();
    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      const inTitle = titleLower.includes(term);
      const inClause = clauseLower.includes(term);
      const inBody = textLower.includes(term);
      if (!inTitle && !inClause && !inBody) continue;
      matched.push(term);
      // Weighted scoring: title heading carries the most signal, then
      // explicit clause, then body. A single term can hit multiple
      // surfaces and stack.
      if (inTitle) score += 4;
      if (inClause) score += 3;
      if (inBody) score += 1;
    }

    if (score >= minScore) {
      hits.push({ document, chunk, score, matched_terms: matched });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title));
  return hits.slice(0, limit);
}
