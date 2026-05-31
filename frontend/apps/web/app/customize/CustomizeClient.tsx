'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import clsx from 'clsx';

import { BackLink } from '@petrobrain/ui';

import {
  CONNECTORS,
  CONNECTOR_CATEGORIES,
  PLUGINS,
  PLUGIN_CATEGORIES,
  SKILLS,
  SKILL_CATEGORIES,
  type ConnectorEntry,
  type PluginEntry,
  type SkillEntry,
} from '@/lib/chat/catalog';
import { usePendingPromptStore } from '@/lib/chat/pendingPrompt';

type Tab = 'skills' | 'connectors' | 'plugins';

const TABS: { key: Tab; label: string; description: string }[] = [
  { key: 'skills', label: 'Skills', description: 'One-shot prompts for common oil & gas workflows.' },
  {
    key: 'connectors',
    label: 'Connectors',
    description: 'Data sources we plan to surface inside chat - SCADA, ERP, regulatory feeds.',
  },
  {
    key: 'plugins',
    label: 'Plugins',
    description: 'In-chat calculators, modelers and integrity tools - bringing PetroBrain into the day-to-day.',
  },
];

function StatusBadge({ status }: { status: 'planned' | 'in_review' | 'beta' }) {
  const styles =
    status === 'beta'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-200'
      : status === 'in_review'
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-200'
        : 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300';
  const label = status === 'beta' ? 'Beta' : status === 'in_review' ? 'In review' : 'Planned';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        styles,
      )}
    >
      {label}
    </span>
  );
}

function SkillCard({ skill }: { skill: SkillEntry }) {
  const router = useRouter();
  const setPending = usePendingPromptStore((s) => s.setPending);

  function useInChat() {
    setPending(skill.prompt);
    router.push('/chat');
  }

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-brand-md dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold tracking-tight text-primary-700 dark:text-primary-300">
            {skill.slug}
          </p>
          <h3 className="mt-0.5 text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {skill.name}
          </h3>
        </div>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
          {SKILL_CATEGORIES[skill.category]}
        </span>
      </header>
      <p className="mb-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{skill.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">By {skill.publisher}</span>
        <button
          type="button"
          onClick={useInChat}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gradient-to-b from-primary-500 to-primary-700 px-3 text-xs font-semibold text-white shadow-[0_6px_14px_-6px_rgba(234,88,12,0.55)] transition-all hover:from-primary-400 hover:to-primary-600"
        >
          Use in chat
          <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
            <path
              d="M5 10h10M11 6l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </article>
  );
}

function ConnectorCard({ c }: { c: ConnectorEntry }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-brand-md dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {c.vendor}
          </p>
          <h3 className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{c.name}</h3>
        </div>
        <StatusBadge status={c.status} />
      </header>
      <p className="mb-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{c.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
          {CONNECTOR_CATEGORIES[c.category]}
        </span>
        <button
          type="button"
          disabled
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
        >
          Request access
        </button>
      </div>
    </article>
  );
}

function PluginCard({ p }: { p: PluginEntry }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-brand-md dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {p.publisher}
          </p>
          <h3 className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{p.name}</h3>
        </div>
        <StatusBadge status={p.status} />
      </header>
      <p className="mb-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{p.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
          {PLUGIN_CATEGORIES[p.category]}
        </span>
        <button
          type="button"
          disabled
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
        >
          Enable
        </button>
      </div>
    </article>
  );
}

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

export function CustomizeClient() {
  const params = useSearchParams();
  const initialTab = (params?.get('tab') as Tab | null) ?? 'skills';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState('');

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (tab === 'skills') {
      return SKILLS.filter(
        (s) =>
          !needle ||
          s.name.toLowerCase().includes(needle) ||
          s.slug.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle),
      );
    }
    if (tab === 'connectors') {
      return CONNECTORS.filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          c.vendor.toLowerCase().includes(needle) ||
          c.description.toLowerCase().includes(needle),
      );
    }
    return PLUGINS.filter(
      (p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.publisher.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle),
    );
  }, [query, tab]);

  const activeTab = TABS.find((t) => t.key === tab)!;

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

        <header className="mt-4 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-600 dark:text-primary-400">
            Customize
          </p>
          <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400 sm:text-4xl">
            Skills, connectors &amp; plugins
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            Everything here is scoped to oil &amp; gas. Skills drop a ready-made prompt into the chat
            composer. Connectors and plugins surface what we&apos;re building next - request the ones
            you need.
          </p>
        </header>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex items-center gap-1 rounded-2xl border border-neutral-200/70 bg-white/70 p-1 shadow-brand-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/60">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={clsx(
                  'inline-flex h-9 items-center rounded-xl px-4 text-sm font-semibold transition-all',
                  tab === t.key
                    ? 'bg-gradient-to-b from-primary-500 to-primary-700 text-white shadow-brand-primary'
                    : 'text-neutral-600 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-300 dark:hover:bg-primary-900/30 dark:hover:text-primary-200',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="relative max-w-md flex-1 sm:max-w-xs">
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
              placeholder={`Search ${activeTab.label.toLowerCase()}…`}
              aria-label={`Search ${activeTab.label}`}
              className="h-10 w-full rounded-xl border border-neutral-200/70 bg-white/80 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 shadow-brand-sm backdrop-blur transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
            />
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{activeTab.description}</p>

        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {tab === 'skills'
            ? (items as SkillEntry[]).map((s) => <SkillCard key={s.slug} skill={s} />)
            : tab === 'connectors'
              ? (items as ConnectorEntry[]).map((c) => <ConnectorCard key={c.slug} c={c} />)
              : (items as PluginEntry[]).map((p) => <PluginCard key={p.slug} p={p} />)}
        </section>

        {items.length === 0 ? (
          <p className="mt-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
            No {activeTab.label.toLowerCase()} match that search.
          </p>
        ) : null}
      </div>
    </main>
  );
}
