'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Badge, Banner, Button, Card, Input } from '@petrobrain/ui';

import { queryAudit } from '@/lib/admin-console/api';
import { useAdminSession } from '@/lib/session/store';

import { AdminShell } from '../../../AdminShell';
import { AuthGate } from '../../../AuthGate';

export interface AuditFilters {
  user_id: string;
  module: string;
  action: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditFilters = { user_id: '', module: '', action: '', from: '', to: '' };

export function AuditClient({ tenantId }: { tenantId: string }) {
  const token = useAdminSession((s) => s.token);
  const principal = useAdminSession((s) => s.principal);
  const apiBaseUrl = useAdminSession((s) => s.apiBaseUrl);

  if (!token || !principal) return <AuthGate />;

  if (
    principal.role !== 'platform_admin' &&
    !(principal.role === 'admin' && principal.tenantId === tenantId)
  ) {
    return (
      <AdminShell title="Forbidden" subtitle="">
        <Banner tone="danger" title="Cross-tenant access denied">
          Use a platform_admin token to read another tenant&apos;s audit log.
        </Banner>
      </AdminShell>
    );
  }

  // Data/state hooks live in the authed view so they run unconditionally (the
  // gate above can early-return before they would otherwise be reached).
  return <AuditView tenantId={tenantId} token={token} apiBaseUrl={apiBaseUrl} />;
}

function AuditView({
  tenantId,
  token,
  apiBaseUrl,
}: {
  tenantId: string;
  token: string;
  apiBaseUrl: string;
}) {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [committed, setCommitted] = useState<AuditFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const limit = 50;

  const query = useQuery({
    queryKey: ['audit', tenantId, committed, page] as const,
    queryFn: ({ signal }) =>
      queryAudit({
        baseUrl: apiBaseUrl,
        token,
        signal,
        tenantId,
        ...(committed.from ? { from: new Date(committed.from).toISOString() } : {}),
        ...(committed.to ? { to: new Date(committed.to).toISOString() } : {}),
        ...(committed.user_id ? { user_id: committed.user_id } : {}),
        ...(committed.module ? { module: committed.module } : {}),
        ...(committed.action ? { action: committed.action } : {}),
        limit,
        offset: page * limit,
      }),
  });

  return (
    <AdminShell
      title={`Audit log - ${tenantId}`}
      subtitle="Hash-only audit_events. No raw user text or model output leaves the audit store."
    >
      <Card title="Filters">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(0);
            setCommitted(filters);
          }}
        >
          <Input
            label="From"
            type="datetime-local"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
          <Input
            label="To"
            type="datetime-local"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
          <Input
            label="User"
            placeholder="user_id"
            value={filters.user_id}
            onChange={(e) => setFilters((f) => ({ ...f, user_id: e.target.value }))}
          />
          <Input
            label="Module"
            placeholder="general | well_control | …"
            value={filters.module}
            onChange={(e) => setFilters((f) => ({ ...f, module: e.target.value }))}
          />
          <div className="flex items-end gap-2">
            <Button type="submit" variant="primary">
              Apply
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setCommitted(EMPTY_FILTERS);
                setPage(0);
              }}
            >
              Reset
            </Button>
          </div>
        </form>
      </Card>

      {query.isError ? (
        <Banner tone="danger" title="Could not load audit log">
          {(query.error as Error)?.message ?? 'Check the API base URL and JWT.'}
        </Banner>
      ) : null}

      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
          Events - {query.data?.count ?? 0}
        </h2>
        {query.isLoading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : query.data && query.data.events.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-md border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Time (UTC)</th>
                  <th className="px-3 py-2 text-left">User</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Module</th>
                  <th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Flags</th>
                  <th className="px-3 py-2 text-left">Request hash</th>
                  <th className="px-3 py-2 text-left">Response hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 bg-white">
                {query.data.events.map((event) => (
                  <tr key={event.id} data-testid={`audit-${event.id}`}>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-700">
                      {event.ts.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-700">{event.user_id}</td>
                    <td className="px-3 py-2 text-xs text-neutral-700">{event.role}</td>
                    <td className="px-3 py-2 text-xs text-neutral-700">{event.module}</td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-800">{event.action}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {event.flags.length === 0 ? (
                          <span className="text-xs text-neutral-400">-</span>
                        ) : (
                          event.flags.map((flag) => (
                            <Badge key={flag} tone="warn">
                              {flag}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-600">
                      {event.request_hash.slice(0, 10)}…
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-600">
                      {event.response_hash.slice(0, 10)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">No events match the current filter.</p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Prev
          </Button>
          <span className="text-xs text-neutral-500">page {page + 1}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={(query.data?.events.length ?? 0) < limit}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </Card>
    </AdminShell>
  );
}
