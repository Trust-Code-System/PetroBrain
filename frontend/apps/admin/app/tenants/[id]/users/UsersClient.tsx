'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge, Banner, Button, Card, Input, Select } from '@petrobrain/ui';

import {
  inviteUser,
  listUsers,
  setUserRole,
  setUserStatus,
} from '@/lib/admin-console/api';
import {
  USER_ROLES,
  type UserRole,
  type UserRow,
} from '@/lib/admin-console/types';
import { useAdminSession } from '@/lib/session/store';

import { AdminShell } from '../../../AdminShell';
import { AuthGate } from '../../../AuthGate';

const usersKey = (tenantId: string) => ['tenants', tenantId, 'users'] as const;

const ROLE_OPTIONS = USER_ROLES.map((r) => ({ value: r, label: r }));

export function UsersClient({ tenantId }: { tenantId: string }) {
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
          Your token is scoped to <code className="font-mono">{principal.tenantId}</code>. Only
          platform admins can read other tenants&apos; users.
        </Banner>
      </AdminShell>
    );
  }

  // Data/state hooks live in the authed view so they run unconditionally (the
  // gate above can early-return before they would otherwise be reached).
  return <UsersView tenantId={tenantId} token={token} apiBaseUrl={apiBaseUrl} />;
}

function UsersView({
  tenantId,
  token,
  apiBaseUrl,
}: {
  tenantId: string;
  token: string;
  apiBaseUrl: string;
}) {
  const qc = useQueryClient();

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('engineer');
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: usersKey(tenantId),
    queryFn: ({ signal }) => listUsers({ baseUrl: apiBaseUrl, token, tenantId, signal }),
  });

  const invite = useMutation({
    mutationFn: () =>
      inviteUser({ baseUrl: apiBaseUrl, token, tenantId, email: inviteEmail, role: inviteRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: usersKey(tenantId) });
      setInviteEmail('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const role = useMutation({
    mutationFn: (input: { user: UserRow; role: UserRole }) =>
      setUserRole({
        baseUrl: apiBaseUrl,
        token,
        tenantId,
        userId: input.user.id,
        role: input.role,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey(tenantId) }),
  });

  const status = useMutation({
    mutationFn: (input: { user: UserRow; status: UserRow['status'] }) =>
      setUserStatus({
        baseUrl: apiBaseUrl,
        token,
        tenantId,
        userId: input.user.id,
        status: input.status,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey(tenantId) }),
  });

  return (
    <AdminShell
      title={`Users - ${tenantId}`}
      subtitle="Invite, set role, activate, deactivate. Audited via /admin/audit."
    >
      <Card title="Invite user" description="POST /admin/tenants/{id}/users">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!inviteEmail.trim()) return;
            invite.mutate();
          }}
        >
          <Input
            label="Email"
            type="email"
            placeholder="user@operator.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <Select
            label="Role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as UserRole)}
            options={ROLE_OPTIONS}
          />
          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              disabled={invite.isPending || !inviteEmail.trim()}
              loading={invite.isPending}
            >
              Send invite
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
        <Banner tone="danger" title="Could not load users">
          {(query.error as Error)?.message ?? 'Check the API base URL and JWT.'}
        </Banner>
      ) : null}

      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
          Users - {query.data?.length ?? 0}
        </h2>
        {query.isLoading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : query.data && query.data.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-md border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Email</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Invited</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 bg-white">
                {query.data.map((user) => (
                  <tr key={user.id} data-testid={`user-${user.id}`}>
                    <td className="px-3 py-2 text-neutral-800">{user.email}</td>
                    <td className="px-3 py-2">
                      <div className="w-36">
                        <Select
                          label=""
                          aria-label={`Role for ${user.email}`}
                          value={user.role}
                          onChange={(e) =>
                            role.mutate({ user, role: e.target.value as UserRole })
                          }
                          disabled={role.isPending}
                          options={ROLE_OPTIONS}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(user.status)}>{user.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {user.invited_at_utc.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        {user.status !== 'active' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={status.isPending}
                            onClick={() => status.mutate({ user, status: 'active' })}
                          >
                            Activate
                          </Button>
                        ) : null}
                        {user.status !== 'deactivated' ? (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={status.isPending}
                            onClick={() => status.mutate({ user, status: 'deactivated' })}
                          >
                            Deactivate
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">No users yet.</p>
        )}
      </Card>
    </AdminShell>
  );
}

function statusTone(status: UserRow['status']): 'safe' | 'warn' | 'danger' {
  if (status === 'active') return 'safe';
  if (status === 'invited') return 'warn';
  return 'danger';
}
