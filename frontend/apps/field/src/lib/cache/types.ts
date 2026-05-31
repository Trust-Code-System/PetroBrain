/**
 * Local document cache types (pure TS - importable without React Native).
 *
 * The shape mirrors a subset of the backend's doc_chunks rows: each
 * document carries title/revision/asset metadata + the chunked body.
 * Cache rows are tenant-scoped on read so a misrouted query returns
 * nothing instead of leaking another tenant's SOPs.
 */
export interface CachedDocument {
  id: string;
  tenant_id: string;
  document_id: string;
  title: string;
  revision: string;
  asset: string | null;
  document_type: string;
  /** Full body text for offline TTS readout (small documents only). */
  text: string;
  updated_utc: string;
}

export interface CachedChunk {
  id: string;
  document_id: string;
  clause: string | null;
  text: string;
}

export interface CachedHit {
  document: CachedDocument;
  chunk: CachedChunk;
  /** Higher is better. 0 means no match. */
  score: number;
  /** Substrings of the chunk text that contributed to the score. */
  matched_terms: string[];
}
