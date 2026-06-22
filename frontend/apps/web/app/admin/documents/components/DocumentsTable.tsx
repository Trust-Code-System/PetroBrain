'use client';

import { Button } from '@petrobrain/ui';

import type { AdminDocumentRow, DocumentStatus } from '@/lib/admin-documents/types';

import { StatusBadge } from './StatusBadge';

/** Only stranded ingests can be re-dispatched; the backend rejects the rest. */
const REQUEUEABLE: ReadonlySet<DocumentStatus> = new Set(['queued', 'failed']);

function canRequeue(row: AdminDocumentRow): boolean {
  return REQUEUEABLE.has(row.status) && !row.ingest_id.startsWith('optimistic-');
}

export interface DocumentsTableProps {
  rows: AdminDocumentRow[];
  isLoading: boolean;
  isError: boolean;
  emptyState?: React.ReactNode;
  /** When provided, requeueable rows show a "Requeue" action. */
  onRequeue?: (ingestId: string) => void;
  /** ingest_id currently being re-dispatched, for the per-row spinner. */
  requeuingId?: string | null;
}

export function DocumentsTable({
  rows,
  isLoading,
  isError,
  emptyState,
  onRequeue,
  requeuingId,
}: DocumentsTableProps) {
  if (isError) {
    return (
      <p role="alert" className="rounded-md border border-danger-border bg-danger-bg p-3 text-sm text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
        Could not load documents. Sign in again or try later.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400">
        {isLoading ? 'Loading documents…' : emptyState ?? 'No documents yet.'}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">Title</th>
            <th scope="col" className="px-3 py-2 text-left">Revision</th>
            <th scope="col" className="px-3 py-2 text-left">Type</th>
            <th scope="col" className="px-3 py-2 text-left">Asset</th>
            <th scope="col" className="px-3 py-2 text-left">Status</th>
            <th scope="col" className="px-3 py-2 text-left">Chunks</th>
            <th scope="col" className="px-3 py-2 text-left">Updated</th>
            {onRequeue ? <th scope="col" className="px-3 py-2 text-right">Actions</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-900/60">
          {rows.map((row) => (
            <tr key={row.ingest_id} data-testid={`row-${row.ingest_id}`}>
              <td className="px-3 py-2">
                <div className="font-medium text-neutral-800 dark:text-neutral-100">{row.title}</div>
                <div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{row.filename}</div>
              </td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{row.revision || '-'}</td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{row.document_type}</td>
              <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">{row.asset ?? '-'}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  <StatusBadge status={row.status} />
                  {row.failure_reason ? (
                    <span className="text-xs text-danger-fg dark:text-danger-bg">{row.failure_reason}</span>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums text-neutral-700 dark:text-neutral-300">{row.chunk_count}</td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {formatRelative(row.updated_utc)}
              </td>
              {onRequeue ? (
                <td className="px-3 py-2 text-right">
                  {canRequeue(row) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={requeuingId === row.ingest_id}
                      disabled={Boolean(requeuingId) && requeuingId !== row.ingest_id}
                      onClick={() => onRequeue(row.ingest_id)}
                    >
                      Requeue
                    </Button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return '-';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
