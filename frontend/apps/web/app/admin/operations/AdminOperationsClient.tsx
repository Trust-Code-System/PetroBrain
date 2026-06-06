'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Logo } from '@petrobrain/ui';
import { useChatStore } from '@/lib/chat/store';
import { listAdminTasks, listAudit, listNotifications, updateNotification } from '@/lib/admin-operations/api';

export type AdminView = 'audit' | 'notifications' | 'safety' | 'tasks' | 'compliance';

export function AdminOperationsClient({ view }: { view: AdminView }) {
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const baseUrl = useChatStore((s) => s.apiBaseUrl);
  const hydrated = useChatStore((s) => s.hasHydrated);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (hydrated && (!token || !principal)) window.location.assign('/signin');
    else if (hydrated && !['admin', 'platform_admin'].includes(principal?.role ?? '')) window.location.assign('/chat');
  }, [hydrated, token, principal]);
  if (!hydrated) return <main className="grid min-h-screen place-items-center"><Logo size={40} glow /></main>;
  if (!token || !principal || !['admin', 'platform_admin'].includes(principal.role)) return null;
  return <AdminViewContent view={view} baseUrl={baseUrl} token={token} filter={filter} setFilter={setFilter} />;
}

function AdminViewContent({ view, baseUrl, token, filter, setFilter }: { view: AdminView; baseUrl: string; token: string; filter: string; setFilter: (value: string) => void }) {
  const auth = { baseUrl, token };
  const audit = useQuery({ queryKey: ['admin-audit', view, filter], queryFn: ({ signal }) => listAudit({ ...auth, signal }, view === 'safety' ? '/safety-events' : filter ? `?action=${encodeURIComponent(filter)}` : ''), enabled: view === 'audit' || view === 'safety' });
  const notifications = useQuery({ queryKey: ['admin-notifications', view, filter], queryFn: ({ signal }) => listNotifications({ ...auth, signal }, view === 'safety' ? '?category=safety' : filter ? `?severity=${encodeURIComponent(filter)}` : ''), enabled: view === 'notifications' || view === 'safety', refetchInterval: 8_000 });
  const tasks = useQuery({ queryKey: ['admin-tasks', view], queryFn: ({ signal }) => listAdminTasks({ ...auth, signal }, view === 'compliance'), enabled: view === 'tasks' || view === 'compliance' });
  const queryClient = useQueryClient();
  const status = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'resolve' }) => updateNotification(auth, id, action), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-notifications'] }) });
  const title = { audit: 'Audit trail', notifications: 'Admin notifications', safety: 'Safety events', tasks: 'Tenant tasks', compliance: 'Compliance tasks' }[view];
  return <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
    <header className="border-b bg-white dark:border-neutral-800 dark:bg-neutral-950"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4"><div><h1 className="text-xl font-semibold">{title}</h1><p className="text-xs text-neutral-500">Tenant-scoped PetroBrain administration</p></div><a href="/chat" className="text-sm font-medium text-primary-700">Back to chat</a></div></header>
    <div className="mx-auto max-w-7xl px-6 py-6">
      <nav className="mb-5 flex flex-wrap gap-2">{(['audit', 'notifications', 'safety', 'tasks', 'compliance'] as const).map((item) => <a key={item} href={`/admin/${item === 'safety' ? 'safety-events' : item}`} className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${item === view ? 'bg-primary-600 text-white' : 'bg-white ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800'}`}>{item}</a>)}</nav>
      {(view === 'audit' || view === 'notifications') ? <input aria-label="Filter" placeholder={view === 'audit' ? 'Filter by action type' : 'Filter by severity'} value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-4 h-10 w-full max-w-sm rounded-xl border border-neutral-200 bg-white px-3 text-sm dark:border-neutral-700 dark:bg-neutral-900" /> : null}
      {audit.isLoading || notifications.isLoading || tasks.isLoading ? <p className="text-sm text-neutral-500">Loading...</p> : null}
      {view === 'audit' || view === 'safety' ? <div className="space-y-2">{(audit.data?.events ?? []).map((event) => <article key={event.id} className="rounded-xl border bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"><div className="flex justify-between gap-3"><strong>{event.action.replace(/_/g, ' ')}</strong><span className="text-xs text-neutral-500">{new Date(event.ts).toLocaleString()}</span></div><p className="mt-1 text-xs text-neutral-500">User {event.user_id} · {event.role} · {event.module} · {String(event.usage['risk_level'] ?? 'low')} risk</p>{event.flags.length ? <p className="mt-2 text-xs text-red-600">{event.flags.join(', ')}</p> : null}</article>)}</div> : null}
      {view === 'notifications' || view === 'safety' ? <div className="space-y-2">{(notifications.data?.notifications ?? []).map((item) => <article key={item.notification_id} className={`rounded-xl border bg-white p-4 dark:bg-neutral-900 ${item.severity === 'critical' ? 'border-red-400 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-800'}`}><div className="flex justify-between"><strong>{item.title}</strong><span className="text-xs font-semibold uppercase text-red-600">{item.severity}</span></div><p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{item.message}</p><p className="mt-2 text-xs text-neutral-500">User {item.user_name || item.user_id || 'unknown'} · {item.user_role || 'unknown role'} · {new Date(item.created_at).toLocaleString()}</p><div className="mt-3 flex gap-2"><button disabled={status.isPending || item.status !== 'unread'} onClick={() => status.mutate({ id: item.notification_id, action: 'acknowledge' })} className="rounded-full border px-3 py-1 text-xs disabled:opacity-40">Acknowledge</button><button disabled={status.isPending || item.status === 'resolved'} onClick={() => status.mutate({ id: item.notification_id, action: 'resolve' })} className="rounded-full border px-3 py-1 text-xs disabled:opacity-40">Resolve</button></div></article>)}</div> : null}
      {view === 'tasks' || view === 'compliance' ? <div className="space-y-2">{(tasks.data?.tasks ?? []).filter((task) => view !== 'compliance' || task.compliance_critical).map((task) => <article key={task.task_id} className="rounded-xl border bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><div className="flex justify-between"><strong>{task.title}</strong><span className="text-xs uppercase">{task.status}</span></div><p className="mt-1 text-xs text-neutral-500">{task.category.replace(/_/g, ' ')} · {task.assigned_to_team || 'Unassigned'} · {task.next_run_at ? new Date(task.next_run_at).toLocaleString() : 'No due date'}</p></article>)}</div> : null}
    </div>
  </main>;
}
