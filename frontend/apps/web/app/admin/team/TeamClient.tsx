'use client';

import { useEffect, useMemo, useState } from 'react';

import type { Role } from '@petrobrain/types';
import { BackLink, Input, Select } from '@petrobrain/ui';

import { AuthGate } from '../../chat/components/AuthGate';
import { Combobox } from '@/lib/ui/Combobox';
import { useChatStore } from '@/lib/chat/store';
import {
  createInvitation,
  listInvitations,
  listMembers,
  removeMember,
  updateInvitation,
  updateMember,
  type Invitation,
} from '@/lib/onboarding/api';

const ROLES: Array<{ value: Role; label: string; description: string }> = [
  { value: 'company_admin', label: 'Company Admin', description: 'Workspace, users, settings, sources, and audit.' },
  { value: 'compliance_admin', label: 'Compliance Admin', description: 'Compliance, regulatory tasks, audit, and evidence.' },
  { value: 'hse_manager', label: 'HSE Manager', description: 'PTW, HSE workflows, and safety events.' },
  { value: 'emissions_lead', label: 'Emissions Lead', description: 'MRV, GHG inventory, and emissions reports.' },
  { value: 'engineer', label: 'Engineer', description: 'Technical modules, calculations, and documents.' },
  { value: 'field_supervisor', label: 'Field Supervisor', description: 'PTW, field tasks, and safety workflows.' },
  { value: 'operations_user', label: 'Operations User', description: 'Production, operations, documents, and tasks.' },
  { value: 'commercial_user', label: 'Commercial Analyst', description: 'Market, investment, and due diligence.' },
  { value: 'procurement_user', label: 'Procurement User', description: 'RFQ, vendor, and contract workflows.' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only access.' },
  { value: 'auditor', label: 'Auditor', description: 'Audit and evidence access without settings changes.' },
];

const DEPARTMENTS = [
  'Operations',
  'Production',
  'Drilling / Well Engineering',
  'Engineering',
  'HSE / Safety',
  'Environment / Emissions',
  'Regulatory / Compliance',
  'Maintenance / Integrity',
  'Facilities',
  'Procurement / Supply Chain',
  'Commercial / Trading',
  'Finance',
  'Legal',
  'IT / Digital',
  'Human Resources',
  'Research & Development',
  'Executive / Management',
];

interface Member {
  id: string;
  email: string;
  role: Role;
  status: string;
  last_active_utc?: string | null;
}

export function TeamClient() {
  const token = useChatStore((state) => state.token);
  const principal = useChatStore((state) => state.principal);
  const baseUrl = useChatStore((state) => state.apiBaseUrl);
  const auth = useMemo(() => token ? { baseUrl, token } : null, [baseUrl, token]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('engineer');
  const [department, setDepartment] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth) return;
    let active = true;
    Promise.all([listMembers(auth), listInvitations(auth)])
      .then(([memberResult, inviteResult]) => {
        if (!active) return;
        setMembers(memberResult.members as unknown as Member[]);
        setInvitations(inviteResult.invitations);
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason));
      });
    return () => { active = false; };
  }, [auth]);

  if (!token || !principal) return <AuthGate />;
  if (!['platform_admin', 'admin', 'tenant_owner', 'company_admin', 'compliance_admin', 'auditor'].includes(principal.role)) {
    return <main className="mx-auto max-w-3xl p-8"><p role="alert">Company administration access is required.</p></main>;
  }

  async function refresh(activeAuth = auth) {
    if (!activeAuth) return;
    try {
      const [memberResult, inviteResult] = await Promise.all([
        listMembers(activeAuth),
        listInvitations(activeAuth),
      ]);
      setMembers(memberResult.members as unknown as Member[]);
      setInvitations(inviteResult.invitations);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createInvitation(auth, { email, role, department });
      setNotice(created.delivery?.message || 'Invite created inside PetroBrain.');
      setInviteLink(
        created.invite_path ? `${window.location.origin}${created.invite_path}` : null,
      );
      setEmail('');
      setDepartment('');
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function invitationAction(invitationId: string, action: 'resend' | 'revoke') {
    if (!auth) return;
    setBusy(true);
    try {
      const updated = await updateInvitation(auth, invitationId, { action });
      setNotice(updated.delivery?.message || `Invitation ${action === 'resend' ? 'renewed' : 'revoked'}.`);
      setInviteLink(
        updated.invite_path ? `${window.location.origin}${updated.invite_path}` : null,
      );
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function changeMemberRole(memberId: string, nextRole: Role) {
    if (!auth) return;
    try {
      await updateMember(auth, memberId, nextRole);
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function deactivateMember(memberId: string) {
    if (!auth || !window.confirm('Remove this member from the workspace?')) return;
    try {
      await removeMember(auth, memberId);
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl">
        <BackLink href="/admin/company" label="Company settings" />
        <header className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Company administration</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Team and access</h1>
          <p className="mt-2 text-sm text-neutral-500">Invite coworkers, assign governed roles, and review membership status.</p>
        </header>

        {notice ? <p role="status" className="mt-5 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p> : null}
        {inviteLink ? (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-primary-200 bg-primary-50 p-3 sm:flex-row sm:items-center dark:border-primary-900 dark:bg-primary-950/30">
            <input aria-label="Secure invite link" readOnly value={inviteLink} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
            <button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink)} className="rounded-lg border border-primary-300 px-3 py-1.5 text-xs font-semibold text-primary-700 dark:text-primary-200">
              Copy link
            </button>
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <section className="mt-7 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="text-lg font-semibold">Invite coworker</h2>
          <form onSubmit={submitInvite} className="mt-4 grid items-start gap-3 md:grid-cols-[1fr_220px_220px_auto]">
            <Input
              label="Email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Select
              label="Role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              options={ROLES.map((item) => ({ value: item.value, label: item.label }))}
            />
            <Combobox
              label="Department"
              value={department}
              options={DEPARTMENTS}
              onChange={setDepartment}
              allowOther
              placeholder="Select or type"
              otherPlaceholder="Enter a department"
            />
            <button disabled={busy} className="self-start rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 md:mt-[26px]">
              Create invite
            </button>
          </form>
          <p className="mt-3 text-xs text-neutral-500">{ROLES.find((item) => item.value === role)?.description}</p>
        </section>

        <section className="mt-7 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="border-b p-5 dark:border-neutral-800"><h2 className="font-semibold">Members</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase text-neutral-500 dark:bg-neutral-950"><tr><th className="p-4">Email</th><th className="p-4">Role</th><th className="p-4">Status</th><th className="p-4">Last active</th><th className="p-4">Actions</th></tr></thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id} className="border-t dark:border-neutral-800">
                    <td className="p-4 font-medium">{member.email}</td>
                    <td className="p-4">
                      {member.role === 'tenant_owner' ? (
                        <span>Tenant Owner</span>
                      ) : (
                        <Select
                          label=""
                          className="w-52"
                          value={member.role}
                          onChange={(event) => void changeMemberRole(member.id, event.target.value as Role)}
                          options={ROLES.map((item) => ({ value: item.value, label: item.label }))}
                        />
                      )}
                    </td>
                    <td className="p-4 capitalize">{member.status}</td>
                    <td className="p-4 text-neutral-500">{member.last_active_utc ? new Date(member.last_active_utc).toLocaleString() : 'Not available'}</td>
                    <td className="p-4">
                      {member.role !== 'tenant_owner' ? <button type="button" onClick={() => void deactivateMember(member.id)} className="text-xs font-semibold text-red-600">Remove</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-7 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="font-semibold">Pending invitations</h2>
          <div className="mt-4 space-y-3">
            {invitations.length === 0 ? <p className="text-sm text-neutral-500">No invitations yet.</p> : invitations.map((item) => (
              <article key={item.invitation_id} className="flex flex-col justify-between gap-3 rounded-xl border p-4 dark:border-neutral-800 sm:flex-row sm:items-center">
                <div>
                  <p className="font-medium">{item.email}</p>
                  <p className="mt-1 text-xs text-neutral-500">{formatRole(item.role)} · {item.department || 'No department'} · expires {new Date(item.expires_at).toLocaleDateString()}</p>
                </div>
                <div className="flex gap-2">
                  <button disabled={busy || item.status !== 'pending'} type="button" onClick={() => void invitationAction(item.invitation_id, 'resend')} className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40">Resend</button>
                  <button disabled={busy || item.status !== 'pending'} type="button" onClick={() => void invitationAction(item.invitation_id, 'revoke')} className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-red-600 disabled:opacity-40">Revoke</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function formatRole(role: string) {
  return role.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'The team request could not be completed.';
}
