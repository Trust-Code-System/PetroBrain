'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { Badge, Button, Logo } from '@petrobrain/ui';

import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import { useProjectsStore } from '@/lib/chat/projects';
import { useSettingsStore } from '@/lib/chat/settings';
import { useChatStore } from '@/lib/chat/store';

const NAV: {
  href: '/chat' | '/projects' | '/customize' | '/emissions' | '/admin/documents';
  label: string;
  icon: 'chat' | 'project' | 'customize' | 'leaf' | 'doc';
}[] = [
  { href: '/chat', label: 'Chat', icon: 'chat' },
  { href: '/projects', label: 'Projects', icon: 'project' },
  { href: '/customize', label: 'Customize', icon: 'customize' },
  { href: '/emissions', label: 'Emissions MRV', icon: 'leaf' },
  { href: '/admin/documents', label: 'Documents', icon: 'doc' },
];

function NavIcon({ kind }: { kind: 'chat' | 'project' | 'customize' | 'leaf' | 'doc' }) {
  if (kind === 'chat') {
    return (
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M4 5.5A2.5 2.5 0 016.5 3h7A2.5 2.5 0 0116 5.5v6A2.5 2.5 0 0113.5 14H9l-3.2 2.8a.5.5 0 01-.8-.4V14H6.5A2.5 2.5 0 014 11.5v-6z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'project') {
    return (
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'customize') {
    return (
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M5 4v4M5 12v4M10 4v8M10 16v0M15 4v2M15 10v6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="5" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="10" cy="14" r="1.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="15" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'leaf') {
    return (
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M16 4c0 7-5 12-12 12 0-7 5-12 12-12zM4 16l6-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M6 3h6l4 4v9a1.5 1.5 0 01-1.5 1.5h-8.5A1.5 1.5 0 014.5 16V4.5A1.5 1.5 0 016 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 3v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

interface Conversation {
  id: string;
  ownerKey: string;
  title: string;
  updatedAt: number;
  snippet?: string | null;
}

/**
 * Bucket conversations like ChatGPT/Claude do:
 * Today · Yesterday · Previous 7 Days · Previous 30 Days · Older.
 */
function groupByRecency(items: Conversation[]): Array<{ label: string; rows: Conversation[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 3600 * 1000;
  const start7 = startOfToday - 7 * 24 * 3600 * 1000;
  const start30 = startOfToday - 30 * 24 * 3600 * 1000;

  const buckets: Array<{ label: string; rows: Conversation[]; floor: number }> = [
    { label: 'Today', rows: [], floor: startOfToday },
    { label: 'Yesterday', rows: [], floor: startOfYesterday },
    { label: 'Previous 7 days', rows: [], floor: start7 },
    { label: 'Previous 30 days', rows: [], floor: start30 },
    { label: 'Older', rows: [], floor: -Infinity },
  ];

  for (const item of items) {
    const bucket = buckets.find((b) => item.updatedAt >= b.floor)!;
    bucket.rows.push(item);
  }
  return buckets.filter((b) => b.rows.length > 0).map(({ label, rows }) => ({ label, rows }));
}

function ConversationsList() {
  const principal = useChatStore((s) => s.principal);
  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);

  const conversations = useConversationsStore((s) => s.conversations);
  const order = useConversationsStore((s) => s.order);
  const activeId = useConversationsStore((s) => s.activeId);
  const selectConversation = useConversationsStore((s) => s.selectConversation);
  const deleteConversation = useConversationsStore((s) => s.deleteConversation);
  const renameConversation = useConversationsStore((s) => s.renameConversation);

  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    function onPointer(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [openMenu]);

  const activeProjectId = useProjectsStore((s) => s.activeId);

  const visible = useMemo(() => {
    if (!ownerKey) return [];
    const rows = order
      .map((id) => conversations[id])
      .filter(
        (c): c is NonNullable<typeof c> =>
          c != null &&
          c.ownerKey === ownerKey &&
          (activeProjectId ? c.projectId === activeProjectId : !c.projectId),
      );
    if (!query.trim()) return rows.map((c) => ({ ...c, snippet: null as string | null }));

    const needle = query.trim().toLowerCase();
    const matches: Array<typeof rows[number] & { snippet: string | null }> = [];
    for (const c of rows) {
      if (c.title.toLowerCase().includes(needle)) {
        matches.push({ ...c, snippet: null });
        continue;
      }
      let snippet: string | null = null;
      for (const m of c.messages) {
        const text = (m.text || '').toLowerCase();
        const idx = text.indexOf(needle);
        if (idx !== -1) {
          const raw = m.text || '';
          const start = Math.max(0, idx - 24);
          const end = Math.min(raw.length, idx + needle.length + 40);
          snippet = (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
          break;
        }
      }
      if (snippet) matches.push({ ...c, snippet });
    }
    return matches;
  }, [conversations, order, ownerKey, query, activeProjectId]);

  const grouped = useMemo(() => groupByRecency(visible), [visible]);

  function startRename(id: string, currentTitle: string) {
    setRenaming(id);
    setDraft(currentTitle);
    setOpenMenu(null);
  }

  function commitRename(id: string) {
    renameConversation(id, draft);
    setRenaming(null);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search conversations"
          className="h-9 w-full rounded-xl border border-neutral-200/70 bg-white/80 pl-8 pr-7 text-sm text-neutral-800 placeholder:text-neutral-400 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {grouped.length === 0 ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
            {query
              ? 'No chats match that search.'
              : 'No chats yet. Send a message or hit + above to start one.'}
          </p>
        ) : (
          grouped.map((bucket) => (
            <div key={bucket.label}>
              <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400 dark:text-neutral-500">
                {bucket.label}
              </p>
              <div className="space-y-0.5">
                {bucket.rows.map((c) => {
                  const active = c.id === activeId;
                  const isRenaming = renaming === c.id;
                  const isMenuOpen = openMenu === c.id;
                  return (
                    <div
                      key={c.id}
                      className={clsx(
                        'group relative flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-all',
                        active
                          ? 'bg-gradient-to-r from-primary-50 to-primary-100/70 text-primary-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:from-primary-900/40 dark:to-primary-800/30 dark:text-primary-200'
                          : 'text-neutral-700 hover:bg-white/80 dark:text-neutral-300 dark:hover:bg-neutral-800/60',
                      )}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          aria-label="Rename conversation"
                          placeholder="Conversation name"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => commitRename(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(c.id);
                            else if (e.key === 'Escape') setRenaming(null);
                          }}
                          className="w-full rounded-md border border-primary-300 bg-white px-2 py-1 text-sm outline-none ring-2 ring-primary-200 dark:border-primary-600 dark:bg-neutral-900 dark:text-neutral-100 dark:ring-primary-800"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => selectConversation(c.id)}
                          className="min-w-0 flex-1 text-left font-medium"
                          title={c.title}
                        >
                          <span className="block truncate">{c.title}</span>
                          {c.snippet ? (
                            <span className="block truncate text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
                              {c.snippet}
                            </span>
                          ) : null}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setOpenMenu(isMenuOpen ? null : c.id)}
                        className={clsx(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-opacity hover:bg-white hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
                          active || isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                        aria-label="Conversation actions"
                      >
                        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                          <circle cx="10" cy="4.5" r="1.4" />
                          <circle cx="10" cy="10" r="1.4" />
                          <circle cx="10" cy="15.5" r="1.4" />
                        </svg>
                      </button>

                      {isMenuOpen ? (
                        <div
                          ref={menuRef}
                          className="absolute right-1 top-9 z-40 w-36 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] dark:border-neutral-700 dark:bg-neutral-900"
                        >
                          <button
                            type="button"
                            onClick={() => startRename(c.id, c.title)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200"
                          >
                            <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                              <path
                                d="M4 16l3-1 9-9-2-2-9 9-1 3z"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinejoin="round"
                              />
                            </svg>
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              deleteConversation(c.id);
                              setOpenMenu(null);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-danger-fg hover:bg-danger-bg/70 dark:text-danger-bg dark:hover:bg-danger-fg/20"
                          >
                            <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                              <path
                                d="M5 6h10M8 6V4h4v2m-6 0v10h8V6"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function MenuIcon({ kind }: { kind: 'profile' | 'settings' | 'customize' | 'projects' | 'shortcuts' | 'help' | 'signout' | 'chevron' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none' } as const;
  if (kind === 'profile') {
    return (
      <svg {...common}>
        <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M4 17c.6-3 3-5 6-5s5.4 2 6 5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'settings') {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M10 3v1.5M10 15.5V17M17 10h-1.5M4.5 10H3M15 5l-1 1M6 14l-1 1M15 15l-1-1M6 6L5 5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'customize') {
    return (
      <svg {...common}>
        <path d="M5 4v4M5 12v4M10 4v8M10 16v0M15 4v2M15 10v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="5" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="10" cy="14" r="1.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="15" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (kind === 'projects') {
    return (
      <svg {...common}>
        <path
          d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'shortcuts') {
    return (
      <svg {...common}>
        <rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M6 9h.01M9 9h.01M12 9h.01M15 9h.01M6 12h8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'help') {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M8 8a2 2 0 114 0c0 1-2 1.5-2 3M10 14h.01"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'signout') {
    return (
      <svg {...common}>
        <path
          d="M9 4H5a1 1 0 00-1 1v10a1 1 0 001 1h4M13 7l3 3-3 3M16 10H8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 5l6 5-6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-neutral-700 dark:text-neutral-300">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            <kbd className="rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-700 shadow-[0_1px_0_rgba(15,23,42,0.06)] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {k}
            </kbd>
            {i < keys.length - 1 ? <span className="text-[10px] text-neutral-400 dark:text-neutral-500">+</span> : null}
          </span>
        ))}
      </span>
    </div>
  );
}

function UserCard({
  principal,
  onSignOut,
}: {
  principal: { role: string; userId: string; tenantId: string };
  onSignOut: () => void;
}) {
  const router = useRouter();

  const callMeName = useSettingsStore((s) => s.callMeName);
  const displayNameSetting = useSettingsStore((s) => s.displayName);
  const preferredName = (callMeName || displayNameSetting).trim();
  const isEmail = principal.userId.includes('@');
  const derivedName = isEmail
    ? principal.userId.split('@')[0]!.charAt(0).toUpperCase() + principal.userId.split('@')[0]!.slice(1)
    : principal.userId;
  const displayName = preferredName || derivedName;
  const initials = displayName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'PB';
  const [open, setOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowProfile(false);
        setShowShortcuts(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setShowProfile(false);
        setShowShortcuts(false);
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function go(href: '/customize' | '/projects' | '/settings') {
    router.push(`${href}?from=chat`);
    setOpen(false);
  }

  const menuItemCls =
    'group flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200';
  const menuIconCls = 'text-neutral-500 group-hover:text-primary-600 dark:text-neutral-400 dark:group-hover:text-primary-300';

  return (
    <div ref={popRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-2xl border border-neutral-200/70 bg-white/80 p-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm transition-all hover:border-primary-300 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.20)] dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{displayName}</p>
          <div className="flex items-center gap-1.5">
            <Badge tone="info">{principal.role}</Badge>
            <span className="truncate text-[10px] text-neutral-500 dark:text-neutral-400">{principal.tenantId}</span>
          </div>
        </div>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="shrink-0 text-neutral-400 dark:text-neutral-500">
          <circle cx="10" cy="4.5" r="1.4" />
          <circle cx="10" cy="10" r="1.4" />
          <circle cx="10" cy="15.5" r="1.4" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-50 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="border-b border-neutral-100 px-3 py-2.5 dark:border-neutral-800">
            <p className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100" title={principal.userId}>
              {principal.userId}
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {principal.role} · {principal.tenantId}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowProfile((v) => !v)}
            className={menuItemCls}
            role="menuitem"
            aria-expanded={showProfile}
          >
            <span className={menuIconCls}>
              <MenuIcon kind="profile" />
            </span>
            <span className="flex-1">Profile</span>
            <span
              className={clsx(
                'text-neutral-400 transition-transform group-hover:text-primary-500 dark:text-neutral-500 dark:group-hover:text-primary-400',
                showProfile && 'rotate-90',
              )}
            >
              <MenuIcon kind="chevron" />
            </span>
          </button>
          {showProfile ? (
            <div className="mx-2 mb-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-xl border border-neutral-100 bg-neutral-50/60 p-3 text-[11px] dark:border-neutral-800 dark:bg-neutral-900/60">
              <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">User</span>
              <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{principal.userId}</span>
              <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Role</span>
              <span className="text-neutral-800 dark:text-neutral-200">{principal.role}</span>
              <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Tenant</span>
              <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{principal.tenantId}</span>
            </div>
          ) : null}

          <button type="button" onClick={() => go('/settings')} className={menuItemCls} role="menuitem">
            <span className={menuIconCls}>
              <MenuIcon kind="settings" />
            </span>
            <span className="flex-1">Settings</span>
          </button>

          <button type="button" onClick={() => go('/customize')} className={menuItemCls} role="menuitem">
            <span className={menuIconCls}>
              <MenuIcon kind="customize" />
            </span>
            <span className="flex-1">Customize</span>
          </button>

          <button type="button" onClick={() => go('/projects')} className={menuItemCls} role="menuitem">
            <span className={menuIconCls}>
              <MenuIcon kind="projects" />
            </span>
            <span className="flex-1">Projects</span>
          </button>

          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />

          <button
            type="button"
            onClick={() => setShowShortcuts((v) => !v)}
            className={menuItemCls}
            role="menuitem"
            aria-expanded={showShortcuts}
          >
            <span className={menuIconCls}>
              <MenuIcon kind="shortcuts" />
            </span>
            <span className="flex-1">Keyboard shortcuts</span>
            <span
              className={clsx(
                'text-neutral-400 transition-transform group-hover:text-primary-500 dark:text-neutral-500 dark:group-hover:text-primary-400',
                showShortcuts && 'rotate-90',
              )}
            >
              <MenuIcon kind="chevron" />
            </span>
          </button>
          {showShortcuts ? (
            <div className="mx-2 mb-1 rounded-xl border border-neutral-100 bg-neutral-50/60 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/60">
              <ShortcutRow keys={['Enter']} label="Send message" />
              <ShortcutRow keys={['Shift', 'Enter']} label="New line" />
              <ShortcutRow keys={['Esc']} label="Close popovers" />
            </div>
          ) : null}

          <a
            href="mailto:support@petrobrain.io?subject=PetroBrain support request"
            className={menuItemCls}
            role="menuitem"
          >
            <span className={menuIconCls}>
              <MenuIcon kind="help" />
            </span>
            <span className="flex-1">Help &amp; support</span>
          </a>

          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />

          <button
            type="button"
            onClick={onSignOut}
            className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-danger-fg hover:bg-danger-bg/60 dark:text-danger-bg dark:hover:bg-danger-fg/20"
            role="menuitem"
          >
            <span className="text-danger-fg/80 group-hover:text-danger-fg dark:text-danger-bg/80 dark:group-hover:text-danger-bg">
              <MenuIcon kind="signout" />
            </span>
            <span className="flex-1">Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ActiveProjectStrip() {
  const principal = useChatStore((s) => s.principal);
  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeId);
  const selectProject = useProjectsStore((s) => s.selectProject);

  const activeProject = activeProjectId ? projects[activeProjectId] : null;
  const isMyProject = activeProject && activeProject.ownerKey === ownerKey;

  if (!isMyProject) return null;

  return (
    <div className="flex items-center gap-2 rounded-xl border border-primary-200/70 bg-gradient-to-r from-primary-50 to-primary-100/70 px-2.5 py-1.5 text-xs shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-primary-700/40 dark:from-primary-900/40 dark:to-primary-800/30">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/80 text-primary-700 dark:bg-neutral-900/60 dark:text-primary-300">
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold text-primary-800 dark:text-primary-200" title={activeProject!.name}>
        {activeProject!.name}
      </span>
      <button
        type="button"
        onClick={() => selectProject(null)}
        aria-label="Exit project"
        title="Exit project"
        className="flex h-5 w-5 items-center justify-center rounded-md text-primary-700/60 hover:bg-white/60 hover:text-primary-800 dark:text-primary-300/60 dark:hover:bg-neutral-900/60 dark:hover:text-primary-200"
      >
        <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function ChatSidebar() {
  const pathname = usePathname();
  const principal = useChatStore((s) => s.principal);
  const setToken = useChatStore((s) => s.setToken);
  const selectConversation = useConversationsStore((s) => s.selectConversation);
  const newConversation = useConversationsStore((s) => s.newConversation);
  const activeProjectId = useProjectsStore((s) => s.activeId);
  const projects = useProjectsStore((s) => s.projects);

  function signOut() {
    selectConversation(null);
    setToken(null);
  }

  function newChat() {
    if (!principal) return;
    const ownerKey = `${principal.tenantId}:${principal.userId}`;
    const project = activeProjectId ? projects[activeProjectId] : null;
    const validProjectId = project && project.ownerKey === ownerKey ? activeProjectId : null;
    newConversation(ownerKey, validProjectId);
  }

  return (
    <aside className="flex h-screen min-h-0 flex-col gap-4 border-r border-neutral-200/70 bg-gradient-to-b from-white via-white to-primary-50/40 px-4 py-5 backdrop-blur-sm dark:border-neutral-800/70 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Logo size={32} glow />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">PetroBrain</span>
            <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400">
              Operations Copilot
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={newChat}
          disabled={!principal}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200/70 bg-white/80 text-neutral-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.30)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
          aria-label="New chat"
          title="New chat"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <nav className="space-y-0.5">
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== '/chat' && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={{ pathname: item.href, query: { from: 'chat' } }}
              className={clsx(
                'group flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-medium transition-all',
                active
                  ? 'bg-gradient-to-r from-primary-500 to-primary-600 text-white shadow-[0_6px_14px_-6px_rgba(234,88,12,0.55)]'
                  : 'text-neutral-600 hover:bg-white hover:text-primary-700 hover:shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-primary-300',
              )}
            >
              <span
                className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                  active
                    ? 'bg-white/15 text-white'
                    : 'bg-primary-50 text-primary-600 group-hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 dark:group-hover:bg-primary-800/40',
                )}
              >
                <NavIcon kind={item.icon} />
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <ActiveProjectStrip />

      <ConversationsList />

      {principal ? (
        <UserCard principal={principal} onSignOut={signOut} />
      ) : (
        <Button variant="ghost" size="sm" onClick={signOut} className="w-full justify-start">
          Sign out
        </Button>
      )}
    </aside>
  );
}
