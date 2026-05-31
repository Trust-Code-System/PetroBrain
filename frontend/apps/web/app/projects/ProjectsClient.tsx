'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { BackLink } from '@petrobrain/ui';

import { AuthGate } from '../chat/components/AuthGate';
import { useChatStore } from '@/lib/chat/store';
import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import { useProjectsStore, type Project } from '@/lib/chat/projects';

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

interface DraftProject {
  name: string;
  description: string;
  instructions: string;
}

function ProjectEditor({
  initial,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  initial: DraftProject;
  onSubmit: (draft: DraftProject) => void;
  onCancel: () => void;
  busy?: boolean;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<DraftProject>(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.name.trim()) return;
        onSubmit(draft);
      }}
      className="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70"
    >
      <div className="space-y-1.5">
        <label
          htmlFor="proj-name"
          className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
        >
          Project name
        </label>
        <input
          id="proj-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. OML-DEMO Tier-3 readiness"
          className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="proj-desc"
          className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
        >
          Description
        </label>
        <input
          id="proj-desc"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="What is this project about?"
          className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="proj-instr"
          className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
        >
          Custom instructions
        </label>
        <textarea
          id="proj-instr"
          rows={5}
          value={draft.instructions}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          placeholder="Standing context PetroBrain should follow in this project - facility ID, jurisdiction, target tier, the specific SOPs you care about, the format you want answers in, etc."
          className="w-full resize-none rounded-xl border border-neutral-200 bg-white p-3 text-sm leading-relaxed shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
        />
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Prepended to the system prompt for every chat in this project.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center rounded-full border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!draft.name.trim() || busy}
          className="inline-flex h-9 items-center rounded-full bg-gradient-to-b from-primary-500 to-primary-700 px-4 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ProjectCard({
  project,
  conversationCount,
  onOpen,
  onEdit,
  onDelete,
}: {
  project: Project;
  conversationCount: number;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-brand-md dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600">
      <header className="mb-2 flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <h3 className="truncate text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {project.name}
          </h3>
          {project.description ? (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
              {project.description}
            </p>
          ) : null}
        </button>
        <ProjectActions onEdit={onEdit} onDelete={onDelete} />
      </header>
      <footer className="mt-3 flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
          {conversationCount} {conversationCount === 1 ? 'chat' : 'chats'}
        </span>
        <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
      </footer>
    </article>
  );
}

function ProjectActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Project actions"
        className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-opacity hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="10" cy="4.5" r="1.4" />
          <circle cx="10" cy="10" r="1.4" />
          <circle cx="10" cy="15.5" r="1.4" />
        </svg>
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-30 w-36 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18)] dark:border-neutral-700 dark:bg-neutral-900">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-danger-fg hover:bg-danger-bg/70 dark:text-danger-bg dark:hover:bg-danger-fg/20"
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsClient() {
  const router = useRouter();
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const hasHydrated = useChatStore((s) => s.hasHydrated);
  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);

  const projects = useProjectsStore((s) => s.projects);
  const order = useProjectsStore((s) => s.order);
  const newProject = useProjectsStore((s) => s.newProject);
  const updateProject = useProjectsStore((s) => s.updateProject);
  const deleteProject = useProjectsStore((s) => s.deleteProject);
  const selectProject = useProjectsStore((s) => s.selectProject);

  const conversations = useConversationsStore((s) => s.conversations);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    if (!ownerKey) return [];
    const rows = order
      .map((id) => projects[id])
      .filter((p): p is Project => p != null && p.ownerKey === ownerKey);
    if (!query.trim()) return rows;
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle) ||
        p.instructions.toLowerCase().includes(needle),
    );
  }, [order, projects, ownerKey, query]);

  const conversationCountFor = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of Object.keys(conversations)) {
      const c = conversations[id];
      if (c?.projectId) counts[c.projectId] = (counts[c.projectId] ?? 0) + 1;
    }
    return counts;
  }, [conversations]);

  if (!hasHydrated) {
    return (
      <div
        aria-busy="true"
        className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
      >
        <span className="relative inline-flex h-12 w-12">
          <span className="absolute inset-0 rounded-full bg-primary-200/60 blur-xl dark:bg-primary-700/40" />
          <span
            aria-hidden
            className="relative inline-block h-12 w-12 rounded-full border-2 border-primary-200 border-t-primary-500 animate-spin dark:border-primary-800"
          />
        </span>
      </div>
    );
  }
  if (!token || !principal) return <AuthGate />;

  function openProject(id: string) {
    selectProject(id);
    router.push('/chat');
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-100/40 blur-3xl dark:bg-primary-900/20"
      />

      <div className="relative mx-auto max-w-6xl px-6 py-10">
        <BackHeader />

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-600 dark:text-primary-400">
              Projects
            </p>
            <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400 sm:text-4xl">
              Workspaces for ongoing work
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
              A project bundles chats with shared custom instructions - set the asset, jurisdiction,
              target tier, and answer format once, then have every chat in the project follow them.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={!ownerKey}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-gradient-to-b from-neutral-900 to-neutral-800 px-4 text-sm font-semibold text-white shadow-[0_6px_14px_-6px_rgba(15,23,42,0.45)] transition-all hover:from-neutral-800 hover:to-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:from-primary-700 dark:to-primary-800 dark:hover:from-primary-600 dark:hover:to-primary-700"
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            New project
          </button>
        </header>

        {creating ? (
          <div className="mt-6">
            <ProjectEditor
              initial={{ name: '', description: '', instructions: '' }}
              submitLabel="Create project"
              onCancel={() => setCreating(false)}
              onSubmit={(draft) => {
                if (!ownerKey) return;
                newProject(ownerKey, draft);
                setCreating(false);
              }}
            />
          </div>
        ) : null}

        <div className="mt-6 max-w-md">
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="M13.5 13.5L17 17"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-10 w-full rounded-xl border border-neutral-200/70 bg-white/80 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 shadow-brand-sm backdrop-blur transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
            />
          </div>
        </div>

        <section className={clsx('mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3')}>
          {visible.length === 0 ? (
            <p className="col-span-full mt-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {query
                ? 'No projects match that search.'
                : 'No projects yet. Hit “New project” to create your first workspace.'}
            </p>
          ) : (
            visible.map((p) =>
              editingId === p.id ? (
                <div key={p.id} className="md:col-span-2 lg:col-span-3">
                  <ProjectEditor
                    initial={{
                      name: p.name,
                      description: p.description,
                      instructions: p.instructions,
                    }}
                    submitLabel="Save changes"
                    onCancel={() => setEditingId(null)}
                    onSubmit={(draft) => {
                      updateProject(p.id, draft);
                      setEditingId(null);
                    }}
                  />
                </div>
              ) : (
                <ProjectCard
                  key={p.id}
                  project={p}
                  conversationCount={conversationCountFor[p.id] ?? 0}
                  onOpen={() => openProject(p.id)}
                  onEdit={() => setEditingId(p.id)}
                  onDelete={() => {
                    // Conversations attached to the project just become loose
                    // chats - we don't cascade-delete the user's history.
                    deleteProject(p.id);
                  }}
                />
              ),
            )
          )}
        </section>
      </div>
    </main>
  );
}
