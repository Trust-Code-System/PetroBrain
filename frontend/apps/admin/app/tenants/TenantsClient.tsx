'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge, Banner, Button, Card, Input } from '@petrobrain/ui';

import {
  createTenant,
  listTenants,
  setTenantStatus,
} from '@/lib/admin-console/api';
import type { TenantRow } from '@/lib/admin-console/types';
import { useAdminSession } from '@/lib/session/store';

import { AdminShell } from '../AdminShell';
import { AuthGate } from '../AuthGate';

const TENANTS_KEY = ['tenants'] as const;

export function TenantsClient() {
  const token = useAdminSession((s) => s.token);
  const principal = useAdminSession((s) => s.principal);
  const apiBaseUrl = useAdminSession((s) => s.apiBaseUrl);

  if (!token || !principal) return <AuthGate />;

  if (principal.role !== 'platform_admin') {
    return <TenantAdminLanding tenantId={principal.tenantId} />;
  }

  return <PlatformTenantsList apiBaseUrl={apiBaseUrl} token={token} />;
}

function TenantAdminLanding({ tenantId }: { tenantId: string }) {
  return (
    <AdminShell
      title={`Tenant ${tenantId}`}
      subtitle="Tenant admin scope. Platform-admin token is required to manage other tenants."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <NavCard href={`/tenants/${tenantId}/users` as Route} title="Users" description="Invite, set role, deactivate." />
        <NavCard
          href={`/tenants/${tenantId}/data-readiness` as Route}
          title="Data readiness"
          description="Documents, assets, users, connectors score."
        />
        <NavCard
          href={`/tenants/${tenantId}/audit` as Route}
          title="Audit log"
          description="Hash-only audit_events review."
        />
      </div>
    </AdminShell>
  );
}

function NavCard({ href, title, description }: { href: Route; title: string; description: string }) {
  return (
    <Link href={href} className="block">
      <Card title={title} description={description}>
        <span className="text-sm font-medium text-primary-700">Open →</span>
      </Card>
    </Link>
  );
}

function PlatformTenantsList({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const qc = useQueryClient();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: TENANTS_KEY,
    queryFn: ({ signal }) => listTenants({ baseUrl: apiBaseUrl, token, signal }),
  });

  const create = useMutation({
    mutationFn: () => createTenant({ baseUrl: apiBaseUrl, token, id: newId, name: newName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANTS_KEY });
      setNewId('');
      setNewName('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const suspend = useMutation({
    mutationFn: (tenant: TenantRow) =>
      setTenantStatus({
        baseUrl: apiBaseUrl,
        token,
        id: tenant.id,
        status: tenant.status === 'active' ? 'suspended' : 'active',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TENANTS_KEY }),
  });

  return (
    <AdminShell
      title="Tenants"
      subtitle="Platform-admin scope. Create new tenants, suspend or reactivate."
    >
      <Card title="New tenant" description="POST /admin/tenants">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newId.trim() || !newName.trim()) return;
            create.mutate();
          }}
        >
          <Input
            label="Tenant id"
            placeholder="oml-99"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            hint="Stable identifier - used in JWT claims and URLs."
          />
          <Input
            label="Display name"
            placeholder="Operator A"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending || !newId.trim() || !newName.trim()}
              loading={create.isPending}
            >
              Create tenant
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger-fg">
            {error}
          </p>
        ) : null}
      </Card>

      {query.isError ? (
        <Banner tone="danger" title="Could not load tenants">
          {(query.error as Error)?.message ?? 'Check the API base URL and JWT.'}
        </Banner>
      ) : null}

      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
          Tenants - {query.data?.length ?? 0}
        </h2>
        {query.isLoading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : query.data && query.data.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-md border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">ID</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Created</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 bg-white">
                {query.data.map((tenant) => (
                  <tr key={tenant.id} data-testid={`tenant-${tenant.id}`}>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-800">{tenant.id}</td>
                    <td className="px-3 py-2 text-neutral-700">{tenant.name}</td>
                    <td className="px-3 py-2">
                      <Badge tone={tenant.status === 'active' ? 'safe' : 'warn'}>
                        {tenant.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {tenant.created_utc.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/tenants/${tenant.id}/data-readiness` as Route}
                          className="text-xs font-medium text-primary-700 hover:underline"
                        >
                          Readiness
                        </Link>
                        <Link
                          href={`/tenants/${tenant.id}/users` as Route}
                          className="text-xs font-medium text-primary-700 hover:underline"
                        >
                          Users
                        </Link>
                        <Link
                          href={`/tenants/${tenant.id}/audit` as Route}
                          className="text-xs font-medium text-primary-700 hover:underline"
                        >
                          Audit
                        </Link>
                        <Button
                          variant={tenant.status === 'active' ? 'danger' : 'secondary'}
                          size="sm"
                          onClick={() => suspend.mutate(tenant)}
                          disabled={suspend.isPending}
                        >
                          {tenant.status === 'active' ? 'Suspend' : 'Reactivate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">No tenants yet.</p>
        )}
      </Card>
    </AdminShell>
  );
}
