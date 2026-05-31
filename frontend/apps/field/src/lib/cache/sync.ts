/**
 * Tenant SOP snapshot sync (B5 plug-point, now wired).
 *
 * Calls ``GET /docs/snapshot?since=<ts>`` and maps each returned document +
 * its chunks into the offline cache shape. The HTTP + mapping logic here is
 * pure/injectable (testable without React Native); the device wiring passes a
 * SQLite-backed ``upsert`` and persists ``as_of`` for the next incremental run.
 */
import type { CachedChunk, CachedDocument } from './types.js';

export interface SyncResult {
  ok: boolean;
  delta_documents: number;
  delta_chunks: number;
  note: string;
  as_of?: string;
}

export interface SnapshotChunk {
  clause: string | null;
  text: string;
}

export interface SnapshotDocument {
  ingest_id: string;
  tenant_id: string;
  document_id: string;
  title: string;
  revision: string;
  asset: string | null;
  document_type: string;
  created_utc: string;
  chunks: SnapshotChunk[];
}

export interface SnapshotResponse {
  documents: SnapshotDocument[];
  as_of: string;
  count: number;
}

export type CacheUpsert = (doc: CachedDocument, chunks: CachedChunk[]) => Promise<void> | void;

export function snapshotUrl(baseUrl: string, since?: string | null): string {
  const url = new URL('/docs/snapshot', baseUrl);
  if (since) url.searchParams.set('since', since); // encodes the timestamp's '+'
  return url.toString();
}

/** Map a backend snapshot document to the offline cache document + chunks. */
export function toCachedDocument(doc: SnapshotDocument): {
  document: CachedDocument;
  chunks: CachedChunk[];
} {
  const document: CachedDocument = {
    id: doc.ingest_id,
    tenant_id: doc.tenant_id,
    document_id: doc.document_id,
    title: doc.title,
    revision: doc.revision ?? '',
    asset: doc.asset ?? null,
    document_type: doc.document_type ?? 'sop',
    text: doc.chunks.map((c) => c.text).join('\n\n'),
    updated_utc: doc.created_utc,
  };
  const chunks: CachedChunk[] = doc.chunks.map((c, i) => ({
    id: `${doc.ingest_id}:${i}`,
    document_id: doc.document_id,
    clause: c.clause ?? null,
    text: c.text,
  }));
  return { document, chunks };
}

export async function syncFromBackend(opts: {
  baseUrl: string;
  token: string;
  since?: string | null;
  upsert?: CacheUpsert;
  fetchImpl?: typeof fetch;
}): Promise<SyncResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const resp = await doFetch(snapshotUrl(opts.baseUrl, opts.since), {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (!resp.ok) {
      return { ok: false, delta_documents: 0, delta_chunks: 0, note: `Snapshot failed: HTTP ${resp.status}` };
    }
    const body = (await resp.json()) as SnapshotResponse;
    let deltaChunks = 0;
    for (const doc of body.documents) {
      const { document, chunks } = toCachedDocument(doc);
      if (opts.upsert) await opts.upsert(document, chunks);
      deltaChunks += chunks.length;
    }
    const tail = opts.upsert ? '' : ' (preview - no cache writer wired)';
    return {
      ok: true,
      delta_documents: body.documents.length,
      delta_chunks: deltaChunks,
      as_of: body.as_of,
      note: `Synced ${body.documents.length} document(s), ${deltaChunks} chunk(s) as of ${body.as_of || 'now'}${tail}.`,
    };
  } catch (err) {
    return {
      ok: false,
      delta_documents: 0,
      delta_chunks: 0,
      note: `Sync error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
