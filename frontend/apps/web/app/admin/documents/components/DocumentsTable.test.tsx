import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { filterRows } from './DocumentsScreen';
import { DocumentsTable } from './DocumentsTable';
import type { AdminDocumentRow, DocumentStatus } from '@/lib/admin-documents/types';

function makeRow(overrides: Partial<AdminDocumentRow> = {}): AdminDocumentRow {
  return {
    ingest_id: overrides.ingest_id ?? 'ing-1',
    document_id: overrides.document_id ?? 'SOP-KICK-001',
    title: overrides.title ?? 'Kick Detection SOP',
    revision: overrides.revision ?? 'Rev 1',
    jurisdiction: overrides.jurisdiction ?? 'Nigeria',
    asset: overrides.asset ?? 'eq-101',
    document_type: overrides.document_type ?? 'sop',
    filename: overrides.filename ?? 'kick.md',
    content_type: overrides.content_type ?? 'text/markdown',
    size_bytes: overrides.size_bytes ?? 1024,
    status: overrides.status ?? 'queued',
    chunk_count: overrides.chunk_count ?? 0,
    failure_reason: overrides.failure_reason ?? null,
    created_utc: overrides.created_utc ?? new Date().toISOString(),
    updated_utc: overrides.updated_utc ?? new Date().toISOString(),
  };
}

describe('DocumentsTable', () => {
  it('renders a row per document with title, type, asset, status badge, chunk count', () => {
    render(
      <DocumentsTable
        rows={[
          makeRow({ ingest_id: 'ing-a', title: 'Kick SOP', status: 'queued' }),
          makeRow({ ingest_id: 'ing-b', title: 'Methane MRV', status: 'done', chunk_count: 12 }),
        ]}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText('Kick SOP')).toBeInTheDocument();
    expect(screen.getByText('Methane MRV')).toBeInTheDocument();
    const doneRow = screen.getByTestId('row-ing-b');
    expect(within(doneRow).getByText('done')).toBeInTheDocument();
    expect(within(doneRow).getByText('12')).toBeInTheDocument();
  });

  it('renders the empty state when there are no rows', () => {
    render(
      <DocumentsTable
        rows={[]}
        isLoading={false}
        isError={false}
        emptyState="Drop something above."
      />,
    );
    expect(screen.getByText('Drop something above.')).toBeInTheDocument();
  });

  it('renders a role=alert on fetch error', () => {
    render(<DocumentsTable rows={[]} isLoading={false} isError={true} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows the failure_reason underneath a failed status badge', () => {
    render(
      <DocumentsTable
        rows={[
          makeRow({
            ingest_id: 'ing-x',
            status: 'failed',
            failure_reason: 'extract: encoding error',
          }),
        ]}
        isLoading={false}
        isError={false}
      />,
    );
    const row = screen.getByTestId('row-ing-x');
    expect(within(row).getByText('failed')).toBeInTheDocument();
    expect(within(row).getByText('extract: encoding error')).toBeInTheDocument();
  });

  it('does not show a stale failure_reason underneath a recovered done status', () => {
    render(
      <DocumentsTable
        rows={[
          makeRow({
            ingest_id: 'ing-recovered',
            status: 'done',
            chunk_count: 2,
            failure_reason: 'embed: old error',
          }),
        ]}
        isLoading={false}
        isError={false}
      />,
    );
    const row = screen.getByTestId('row-ing-recovered');
    expect(within(row).getByText('done')).toBeInTheDocument();
    expect(within(row).queryByText('embed: old error')).toBeNull();
  });

  it('shows Requeue only for queued/failed rows and fires onRequeue with the ingest id', () => {
    const onRequeue = vi.fn();
    render(
      <DocumentsTable
        rows={[
          makeRow({ ingest_id: 'ing-failed', status: 'failed' }),
          makeRow({ ingest_id: 'ing-done', status: 'done' }),
        ]}
        isLoading={false}
        isError={false}
        onRequeue={onRequeue}
      />,
    );

    const failedRow = screen.getByTestId('row-ing-failed');
    const doneRow = screen.getByTestId('row-ing-done');
    expect(within(failedRow).getByRole('button', { name: 'Requeue' })).toBeInTheDocument();
    expect(within(doneRow).queryByRole('button', { name: 'Requeue' })).toBeNull();

    fireEvent.click(within(failedRow).getByRole('button', { name: 'Requeue' }));
    expect(onRequeue).toHaveBeenCalledWith('ing-failed');
  });

  it('does not render the Requeue action when no onRequeue handler is given', () => {
    render(
      <DocumentsTable
        rows={[makeRow({ ingest_id: 'ing-q', status: 'queued' })]}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
  });

  it('shows Delete on every persisted row and fires onDelete with the ingest id', () => {
    const onDelete = vi.fn();
    render(
      <DocumentsTable
        rows={[
          makeRow({ ingest_id: 'ing-done', status: 'done' }),
          makeRow({ ingest_id: 'ing-failed', status: 'failed' }),
        ]}
        isLoading={false}
        isError={false}
        onDelete={onDelete}
      />,
    );

    const doneRow = screen.getByTestId('row-ing-done');
    expect(within(doneRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    fireEvent.click(within(doneRow).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('ing-done');
  });

  it('does not offer Delete for an optimistic (not-yet-persisted) row', () => {
    render(
      <DocumentsTable
        rows={[makeRow({ ingest_id: 'optimistic-pending-1', status: 'queued' })]}
        isLoading={false}
        isError={false}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('does not render the Delete action when no onDelete handler is given', () => {
    render(
      <DocumentsTable
        rows={[makeRow({ ingest_id: 'ing-d', status: 'done' })]}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('filterRows', () => {
  const rows = [
    makeRow({ ingest_id: 'a', status: 'queued', document_type: 'sop', asset: 'eq-1' }),
    makeRow({ ingest_id: 'b', status: 'done', document_type: 'standard', asset: 'eq-2' }),
    makeRow({ ingest_id: 'c', status: 'failed', document_type: 'sop', asset: null }),
  ];

  it('passes everything through when filters are "all"', () => {
    expect(
      filterRows(rows, { status: 'all', type: 'all', asset: 'all' }).map((r) => r.ingest_id),
    ).toEqual(['a', 'b', 'c']);
  });

  it.each<[{ status: DocumentStatus | 'all'; type: string; asset: string }, string[]]>([
    [{ status: 'done', type: 'all', asset: 'all' }, ['b']],
    [{ status: 'all', type: 'sop', asset: 'all' }, ['a', 'c']],
    [{ status: 'all', type: 'all', asset: 'eq-1' }, ['a']],
    [{ status: 'failed', type: 'sop', asset: 'all' }, ['c']],
  ])('filters by %o → %o', (filters, expected) => {
    expect(
      filterRows(rows, {
        status: filters.status,
        // narrow string → DocumentFilterState union members via cast
        type: filters.type as never,
        asset: filters.asset,
      }).map((r) => r.ingest_id),
    ).toEqual(expected);
  });
});
