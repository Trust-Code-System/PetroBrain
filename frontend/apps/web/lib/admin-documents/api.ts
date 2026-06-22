/**
 * Thin fetch wrappers around the FastAPI ``/admin/documents`` routes.
 *
 * The shared ``@petrobrain/api`` openapi-fetch client will subsume these
 * once ``pnpm gen:api`` runs against a live backend; in the meantime the
 * wire shapes match the response models that A5 ships.
 */
import type { AdminDocumentMetadata, AdminDocumentRow } from './types.js';

interface RequestOpts {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
}

export async function listAdminDocuments(opts: RequestOpts): Promise<AdminDocumentRow[]> {
  const init: RequestInit = { headers: { Authorization: `Bearer ${opts.token}` } };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL('/admin/documents', opts.baseUrl), init);
  if (!resp.ok) throw apiError(resp);
  const body = (await resp.json()) as { documents: AdminDocumentRow[] };
  return body.documents;
}

export async function getAdminDocument(opts: RequestOpts & { ingestId: string }): Promise<AdminDocumentRow> {
  const init: RequestInit = { headers: { Authorization: `Bearer ${opts.token}` } };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL(`/admin/documents/${opts.ingestId}`, opts.baseUrl), init);
  if (!resp.ok) throw apiError(resp);
  return (await resp.json()) as AdminDocumentRow;
}

/**
 * Re-dispatch a single stuck ingest (status ``queued`` or ``failed``). The
 * backend re-pulls the already-persisted bytes and re-runs extract -> embed.
 * Returns the updated row (in eager mode it reflects the terminal status).
 */
export async function requeueAdminDocument(
  opts: RequestOpts & { ingestId: string },
): Promise<AdminDocumentRow> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
  };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL(`/admin/documents/${opts.ingestId}/requeue`, opts.baseUrl), init);
  if (!resp.ok) throw apiError(resp);
  return (await resp.json()) as AdminDocumentRow;
}

export interface RequeueStuckResult {
  requeued: number;
  results: { ingest_id: string; status: string; detail?: string }[];
}

/** Bulk re-dispatch every ``queued``/``failed`` ingest for the tenant. */
export async function requeueStuckAdminDocuments(
  opts: RequestOpts,
): Promise<RequeueStuckResult> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
  };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL('/admin/documents/requeue-stuck', opts.baseUrl), init);
  if (!resp.ok) throw apiError(resp);
  return (await resp.json()) as RequeueStuckResult;
}

export interface UploadOpts extends RequestOpts {
  file: File;
  metadata: AdminDocumentMetadata;
}

/**
 * Multipart upload matching the FastAPI handler:
 *   file:     uploaded binary
 *   metadata: JSON string with AdminDocumentMetadata
 * The route gates on ``role=admin`` and verifies the asset is in the
 * principal's ``allowed_assets`` before persisting.
 */
export async function uploadAdminDocument(opts: UploadOpts): Promise<AdminDocumentRow> {
  const form = new FormData();
  form.append('file', opts.file);
  form.append('metadata', JSON.stringify(opts.metadata));

  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL('/admin/documents', opts.baseUrl), init);
  if (!resp.ok) throw apiError(resp);
  return (await resp.json()) as AdminDocumentRow;
}

async function apiError(resp: Response): Promise<never> {
  let detail = '';
  try {
    const body = (await resp.clone().json()) as { detail?: unknown };
    detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? '');
  } catch {
    detail = await resp.text().catch(() => '');
  }
  throw new Error(`admin documents request failed (${resp.status}): ${detail}`);
}
