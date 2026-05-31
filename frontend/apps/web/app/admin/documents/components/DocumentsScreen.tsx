'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { BackLink, Badge } from '@petrobrain/ui';

import { fetchAssets } from '@/lib/chat/assets';
import { useChatStore } from '@/lib/chat/store';
import {
  getAdminDocument,
  listAdminDocuments,
  uploadAdminDocument,
} from '@/lib/admin-documents/api';
import { POLL_INTERVAL_MS, shouldKeepPolling } from '@/lib/admin-documents/polling';
import type { AdminDocumentRow, PendingUpload } from '@/lib/admin-documents/types';

import { Dropzone } from './Dropzone';
import { DocumentFilters, type DocumentFilterState } from './DocumentFilters';
import { DocumentsTable } from './DocumentsTable';
import { PendingUploadCard } from './PendingUploadCard';

const DOCUMENTS_QUERY_KEY = ['admin', 'documents'] as const;

function BackHeader() {
  const from = useSearchParams()?.get('from');
  const backToChat = from === 'chat';
  const href = backToChat ? '/chat' : '/';
  const label = backToChat ? 'Back to chat' : 'Back to home';
  return (
    <Link href={href} legacyBehavior passHref>
      <BackLink label={label} />
    </Link>
  );
}

let pendingCounter = 0;

export function DocumentsScreen() {
  const token = useChatStore((s) => s.token)!;
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const queryClient = useQueryClient();

  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [filters, setFilters] = useState<DocumentFilterState>({
    status: 'all',
    type: 'all',
    asset: 'all',
  });

  const documentsQuery = useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: ({ signal }) => listAdminDocuments({ baseUrl: apiBaseUrl, token, signal }),
    // Refetch every POLL_INTERVAL_MS while any row is still moving.
    refetchInterval: (query) => shouldKeepPolling(query.state.data ?? []),
  });

  const assetsQuery = useQuery({
    queryKey: ['assets', 'all'],
    queryFn: ({ signal }) => fetchAssets({ baseUrl: apiBaseUrl, token, signal }),
    staleTime: 60_000,
  });

  const uploadMutation = useMutation({
    mutationFn: (p: PendingUpload) =>
      uploadAdminDocument({
        baseUrl: apiBaseUrl,
        token,
        file: p.file,
        metadata: p.metadata,
      }),
    // Optimistic: surface the upload immediately in the table with a
    // placeholder ingest_id so the user sees something happened. The
    // mutation's onSuccess swaps it out for the real backend row.
    onMutate: async (p) => {
      await queryClient.cancelQueries({ queryKey: DOCUMENTS_QUERY_KEY });
      const previous = queryClient.getQueryData<AdminDocumentRow[]>(DOCUMENTS_QUERY_KEY) ?? [];
      const optimistic: AdminDocumentRow = makeOptimisticRow(p);
      queryClient.setQueryData<AdminDocumentRow[]>(DOCUMENTS_QUERY_KEY, [optimistic, ...previous]);
      setPending((prev) =>
        prev.map((row) => (row.pendingId === p.pendingId ? { ...row, submitting: true, error: null } : row)),
      );
      return { previous, optimisticId: optimistic.ingest_id };
    },
    onError: (err, p, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData<AdminDocumentRow[]>(DOCUMENTS_QUERY_KEY, ctx.previous);
      }
      const message = err instanceof Error ? err.message : String(err);
      setPending((prev) =>
        prev.map((row) =>
          row.pendingId === p.pendingId ? { ...row, submitting: false, error: message } : row,
        ),
      );
    },
    onSuccess: (real, p, ctx) => {
      queryClient.setQueryData<AdminDocumentRow[]>(DOCUMENTS_QUERY_KEY, (old) => {
        const filtered = (old ?? []).filter((row) => row.ingest_id !== ctx?.optimisticId);
        return [real, ...filtered];
      });
      // Poll the just-created ingest job directly so its status flows in even
      // before the next list refetch fires.
      void prefetchIngestStatus(queryClient, apiBaseUrl, token, real.ingest_id);
      setPending((prev) => prev.filter((row) => row.pendingId !== p.pendingId));
    },
  });

  const filteredRows = useMemo(
    () => filterRows(documentsQuery.data ?? [], filters),
    [documentsQuery.data, filters],
  );

  const assetOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const row of documentsQuery.data ?? []) {
      if (row.asset) seen.add(row.asset);
    }
    return Array.from(seen).map((id) => ({ value: id, label: id }));
  }, [documentsQuery.data]);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <BackHeader />
      <header className="space-y-1">
        <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-2xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400">
          Documents
        </h1>
        <p className="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
          Upload SOPs and standards. The worker extracts text, chunks, embeds, and indexes them so the
          chat surface can cite them with document + revision + clause.
        </p>
      </header>

      <Dropzone
        onFilesDropped={(files) => addPending(setPending, files)}
        disabled={uploadMutation.isPending}
      />

      {pending.length > 0 ? (
        <section className="space-y-3" aria-label="Pending uploads">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
            Pending - {pending.length}
          </h2>
          {pending.map((p) => (
            <PendingUploadCard
              key={p.pendingId}
              pending={p}
              assets={assetsQuery.data ?? []}
              onChange={(next) =>
                setPending((prev) => prev.map((row) => (row.pendingId === next.pendingId ? next : row)))
              }
              onSubmit={(p2) => uploadMutation.mutate(p2)}
              onCancel={(pid) => setPending((prev) => prev.filter((row) => row.pendingId !== pid))}
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-3" aria-label="Filters">
        <DocumentFilters value={filters} onChange={setFilters} assetOptions={assetOptions} />
      </section>

      <section className="space-y-3" aria-label="Documents">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
            Documents - {filteredRows.length}
          </h2>
          {documentsQuery.isFetching ? <Badge tone="info">refreshing…</Badge> : null}
          {shouldKeepPolling(documentsQuery.data ?? []) === POLL_INTERVAL_MS ? (
            <Badge tone="info">polling every 5s</Badge>
          ) : null}
        </header>
        <DocumentsTable
          rows={filteredRows}
          isLoading={documentsQuery.isLoading}
          isError={documentsQuery.isError}
          emptyState={'No documents match the current filters. Drop a file above to seed the index.'}
        />
      </section>
    </main>
  );
}

function addPending(setter: React.Dispatch<React.SetStateAction<PendingUpload[]>>, files: File[]) {
  setter((prev) => [
    ...prev,
    ...files.map((file) => {
      pendingCounter += 1;
      return {
        pendingId: `pending-${Date.now()}-${pendingCounter}`,
        file,
        metadata: {
          document_id: deriveDocId(file.name),
          title: deriveTitle(file.name),
          revision: '',
          jurisdiction: '',
          asset: null,
          effective_date: null,
          document_type: 'sop',
        },
        submitting: false,
        error: null,
      };
    }),
  ]);
}

function deriveTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function deriveDocId(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function makeOptimisticRow(p: PendingUpload): AdminDocumentRow {
  const now = new Date().toISOString();
  return {
    ingest_id: `optimistic-${p.pendingId}`,
    document_id: p.metadata.document_id,
    title: p.metadata.title,
    revision: p.metadata.revision,
    jurisdiction: p.metadata.jurisdiction,
    asset: p.metadata.asset,
    document_type: p.metadata.document_type,
    filename: p.file.name,
    content_type: p.file.type || 'application/octet-stream',
    size_bytes: p.file.size,
    status: 'queued',
    chunk_count: 0,
    failure_reason: null,
    created_utc: now,
    updated_utc: now,
  };
}

export function filterRows(
  rows: AdminDocumentRow[],
  filters: DocumentFilterState,
): AdminDocumentRow[] {
  return rows.filter((r) => {
    if (filters.status !== 'all' && r.status !== filters.status) return false;
    if (filters.type !== 'all' && r.document_type !== filters.type) return false;
    if (filters.asset !== 'all' && (r.asset ?? '') !== filters.asset) return false;
    return true;
  });
}

async function prefetchIngestStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  baseUrl: string,
  token: string,
  ingestId: string,
) {
  try {
    const row = await getAdminDocument({ baseUrl, token, ingestId });
    queryClient.setQueryData<AdminDocumentRow[]>(DOCUMENTS_QUERY_KEY, (old) => {
      const cur = old ?? [];
      const idx = cur.findIndex((r) => r.ingest_id === ingestId);
      if (idx === -1) return [row, ...cur];
      const next = cur.slice();
      next[idx] = row;
      return next;
    });
  } catch {
    // The list query will catch up on the next 5 s tick.
  }
}
