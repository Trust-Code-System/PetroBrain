/**
 * Wire types for /admin/documents (A5).
 *
 * ``AdminDocumentRow`` matches the JSON the FastAPI route emits - fields
 * use snake_case so the OpenAPI client and these manual types agree once
 * ``pnpm gen:api`` runs.
 */
export const DOCUMENT_STATUSES = [
  'queued',
  'extracting',
  'embedding',
  'done',
  'failed',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<DocumentStatus> = new Set(['done', 'failed']);

export const DOCUMENT_TYPES = [
  'sop',
  'standard',
  'regulation',
  'permit',
  'report',
  'other',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface AdminDocumentRow {
  ingest_id: string;
  document_id: string;
  title: string;
  revision: string;
  jurisdiction: string;
  asset: string | null;
  document_type: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: DocumentStatus;
  chunk_count: number;
  failure_reason: string | null;
  created_utc: string;
  updated_utc: string;
}

export interface AdminDocumentMetadata {
  document_id: string;
  title: string;
  revision: string;
  jurisdiction: string;
  asset: string | null;
  effective_date: string | null;       // ISO date (yyyy-mm-dd)
  document_type: string;
}

/** A row the user is composing locally; not yet POSTed to the backend. */
export interface PendingUpload {
  pendingId: string;
  file: File;
  metadata: AdminDocumentMetadata;
  submitting: boolean;
  error: string | null;
}
