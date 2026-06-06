'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Logo } from '@petrobrain/ui';
import { AuthGate } from '../chat/components/AuthGate';
import { useChatStore } from '@/lib/chat/store';
import { createTask, listTasks, taskAction } from '@/lib/tasks/api';
import type { PetroTask, TaskCreateInput } from '@/lib/tasks/types';

const CATEGORIES = [
  'emissions_reporting', 'ghg_inventory', 'nuprc_reporting', 'ogmp_2_reporting',
  'ldar_inspection', 'flare_monitoring', 'ptw_expiry', 'permit_renewal',
  'hse_audit', 'hse_training', 'incident_follow_up', 'audit_action',
  'weekly_production_report', 'monthly_management_report', 'research_digest',
];

const EMPTY: TaskCreateInput = {
  title: '', description: '', category: 'compliance_calendar', priority: 'medium',
  recurrence_type: 'none', assigned_to_team: '', due_date: '',
  timezone: 'Africa/Lagos', status: 'active', compliance_critical: true,
  safety_critical: false, reminder_channels: ['in_app'],
};

export function TasksClient() {
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const baseUrl = useChatStore((s) => s.apiBaseUrl);
  const hydrated = useChatStore((s) => s.hasHydrated);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TaskCreateInput>(EMPTY);
  const auth = { baseUrl, token: token ?? '' };
  const query = useQuery({
    queryKey: ['tasks', filter],
    queryFn: ({ signal }) => listTasks({ ...auth, signal }, filter === 'mine' ? '?assigned_to_me=true' : ''),
    enabled: Boolean(token),
  });
  const create = useMutation({
    mutationFn: (input: TaskCreateInput) => createTask(auth, input),
    onSuccess: () => {
      setCreating(false);
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'complete' | 'pause' | 'resume' }) =>
      taskAction(auth, id, action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
  if (!hydrated) return <main className="grid min-h-screen place-items-center"><Logo size={40} glow /></main>;
  if (!token || !principal) return <AuthGate />;
  const tasks = (query.data?.tasks ?? []).filter((task) => matchesFilter(task, filter));

  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/chat" className="text-sm text-neutral-500 hover:text-primary-700">Chat</Link>
            <div><h1 className="text-xl font-semibold">Tasks</h1><p className="text-xs text-neutral-500">Compliance and operations reminders</p></div>
          </div>
          <button onClick={() => setCreating(true)} className="rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white">Create task</button>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-5 flex flex-wrap gap-2">
          {['all', 'mine', 'overdue', 'compliance', 'emissions', 'hse', 'digests'].map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize ${filter === value ? 'bg-primary-600 text-white' : 'bg-white text-neutral-600 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-800'}`}>{value}</button>
          ))}
        </div>
        {query.isLoading ? <p className="text-sm text-neutral-500">Loading tasks...</p> : null}
        {query.error ? <p role="alert" className="text-sm text-red-600">{query.error.message}</p> : null}
        <section className="grid gap-3 md:grid-cols-2">
          {tasks.map((task) => <TaskRow key={task.task_id} task={task} busy={update.isPending} onAction={(action) => update.mutate({ id: task.task_id, action })} />)}
        </section>
        {!query.isLoading && tasks.length === 0 ? <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">No matching PetroBrain tasks.</p> : null}
      </div>
      {creating ? <CreateTaskModal draft={draft} setDraft={setDraft} busy={create.isPending} {...(create.error ? { error: create.error.message } : {})} onClose={() => setCreating(false)} onSubmit={() => create.mutate(draft)} /> : null}
    </main>
  );
}

function TaskRow({ task, busy, onAction }: { task: PetroTask; busy: boolean; onAction: (action: 'complete' | 'pause' | 'resume') => void }) {
  return <article className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-wide text-primary-700">{task.category.replace(/_/g, ' ')}</p><h2 className="mt-1 font-semibold">{task.title}</h2></div><span className="rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-semibold uppercase dark:bg-neutral-800">{task.status}</span></div>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-neutral-500">Team</dt><dd>{task.assigned_to_team || 'Unassigned'}</dd></div><div><dt className="text-neutral-500">Recurrence</dt><dd className="capitalize">{task.recurrence_type}</dd></div><div><dt className="text-neutral-500">Next due</dt><dd>{formatDate(task.next_run_at ?? task.due_date)}</dd></div><div><dt className="text-neutral-500">Priority</dt><dd className="capitalize">{task.priority}</dd></div></dl>
    <div className="mt-4 flex gap-2">{task.status === 'paused' ? <Action label="Resume" disabled={busy} onClick={() => onAction('resume')} /> : <Action label="Pause" disabled={busy || task.status === 'completed'} onClick={() => onAction('pause')} />}<Action label="Complete" disabled={busy || task.status === 'completed'} onClick={() => onAction('complete')} /></div>
  </article>;
}

function Action({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return <button disabled={disabled} onClick={onClick} className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700">{label}</button>;
}

function CreateTaskModal({ draft, setDraft, busy, error, onClose, onSubmit }: { draft: TaskCreateInput; setDraft: (value: TaskCreateInput) => void; busy: boolean; error?: string; onClose: () => void; onSubmit: () => void }) {
  const inputClass = 'h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-primary-900';
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"><form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900"><h2 className="text-lg font-semibold">Create PetroBrain task</h2><Field label="Title"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={inputClass} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Category"><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={inputClass}>{CATEGORIES.map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}</select></Field><Field label="Priority"><select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as TaskCreateInput['priority'] })} className={inputClass}>{['low', 'medium', 'high', 'critical'].map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="Assigned team"><input value={draft.assigned_to_team} onChange={(e) => setDraft({ ...draft, assigned_to_team: e.target.value })} className={inputClass} /></Field><Field label="Recurrence"><select value={draft.recurrence_type} onChange={(e) => setDraft({ ...draft, recurrence_type: e.target.value })} className={inputClass}>{['none', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'].map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="Due date"><input type="datetime-local" value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} className={inputClass} /></Field></div>{error ? <p className="text-sm text-red-600">{error}</p> : null}<p className="text-xs text-neutral-500">This saves an in-app PetroBrain task. Email and calendar delivery are not enabled.</p><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-full border px-4 py-2 text-sm">Cancel</button><button disabled={busy || !draft.title.trim()} className="rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Create</button></div></form></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1 text-xs font-medium text-neutral-600 dark:text-neutral-300"><span>{label}</span>{children}</label>; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString() : 'Not set'; }
function matchesFilter(task: PetroTask, filter: string) {
  if (filter === 'overdue') return Boolean(task.next_run_at && new Date(task.next_run_at) < new Date() && !['completed', 'cancelled'].includes(task.status));
  if (filter === 'compliance') return task.compliance_critical;
  if (filter === 'emissions') return /emissions|ghg|ogmp|ldar|flare/.test(task.category);
  if (filter === 'hse') return /hse|ptw|incident|permit/.test(task.category);
  if (filter === 'digests') return task.category === 'research_digest';
  return true;
}
