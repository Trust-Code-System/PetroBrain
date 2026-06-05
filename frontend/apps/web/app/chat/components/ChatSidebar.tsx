'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

import { Badge, Button, Logo } from '@petrobrain/ui';

import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import { useProjectsStore } from '@/lib/chat/projects';
import { useSettingsStore } from '@/lib/chat/settings';
import { useChatStore } from '@/lib/chat/store';
import type { Message, MessageAttachment } from '@/lib/chat/types';

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
  pinned?: boolean;
  archived?: boolean;
  groupMembers?: string[];
  messages?: Message[];
  snippet?: string | null;
}

/**
 * Bucket conversations like ChatGPT/Claude do:
 * Today · Yesterday · Previous 7 Days · Previous 30 Days · Older.
 */
function groupByRecency(items: Conversation[]): Array<{ label: string; rows: Conversation[] }> {
  const pinned = items.filter((item) => item.pinned);
  const unpinned = items.filter((item) => !item.pinned);
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

  for (const item of unpinned) {
    const bucket = buckets.find((b) => item.updatedAt >= b.floor)!;
    bucket.rows.push(item);
  }
  const recency = buckets.filter((b) => b.rows.length > 0).map(({ label, rows }) => ({ label, rows }));
  return pinned.length > 0 ? [{ label: 'Pinned', rows: pinned }, ...recency] : recency;
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
  const pinConversation = useConversationsStore((s) => s.pinConversation);
  const archiveConversation = useConversationsStore((s) => s.archiveConversation);
  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // The menu is rendered via portal with position:fixed so it never gets
  // clipped by the sidebar's overflow-y-auto. We track the trigger button's
  // viewport rect, recompute on resize/scroll while open, and place the
  // menu next to it. menuRect=null is the "closed" state for the portal.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!openMenu) {
      setTriggerRect(null);
      return;
    }
    function updateRect() {
      const btn = triggerRefs.current.get(openMenu!);
      if (btn) setTriggerRect(btn.getBoundingClientRect());
    }
    updateRect();
    window.addEventListener('resize', updateRect);
    // Scroll on any ancestor moves the trigger - listen on the capture
    // phase so a scroll inside the sidebar's overflow-y-auto bubbles too.
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      const trigger = triggerRefs.current.get(openMenu!);
      if (trigger?.contains(target)) return;
      setOpenMenu(null);
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
          Boolean(c.archived) === showArchived &&
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
  }, [conversations, order, ownerKey, query, activeProjectId, showArchived]);

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

  const fileConversation = filesFor ? conversations[filesFor] : null;
  const menuConversation = openMenu ? conversations[openMenu] : null;
  const uploadedFiles = collectChatFiles(fileConversation);

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

      <button
        type="button"
        onClick={() => setShowArchived((value) => !value)}
        className={clsx(
          'flex h-8 items-center justify-between rounded-xl border px-2.5 text-xs font-semibold transition-all',
          showArchived
            ? 'border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-700/40 dark:bg-primary-900/30 dark:text-primary-200'
            : 'border-neutral-200/70 bg-white/70 text-neutral-500 hover:border-primary-300 hover:text-primary-700 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-400 dark:hover:border-primary-600 dark:hover:text-primary-300',
        )}
      >
        <span>{showArchived ? 'Showing archived chats' : 'Archived chats'}</span>
        <span>{showArchived ? 'Hide' : 'View'}</span>
      </button>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {grouped.length === 0 ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
            {query
              ? 'No chats match that search.'
              : showArchived
                ? 'No archived chats.'
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
                          {c.pinned ? (
                            <span className="mt-0.5 flex items-center gap-1">
                              <span className="rounded-full bg-primary-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
                                Pinned
                              </span>
                            </span>
                          ) : null}
                          {c.snippet ? (
                            <span className="block truncate text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
                              {c.snippet}
                            </span>
                          ) : null}
                        </button>
                      )}

                      <button
                        type="button"
                        ref={(el) => {
                          if (el) triggerRefs.current.set(c.id, el);
                          else triggerRefs.current.delete(c.id);
                        }}
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

                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {openMenu && menuConversation && triggerRect && typeof document !== 'undefined'
        ? createPortal(
            <ConversationMenu
              menuRef={menuRef}
              triggerRect={triggerRect}
              conversation={menuConversation}
              showArchived={showArchived}
              onViewFiles={() => {
                setFilesFor(openMenu);
                setOpenMenu(null);
              }}
              onPin={() => {
                pinConversation(openMenu, !menuConversation.pinned);
                setOpenMenu(null);
              }}
              onArchive={() => {
                archiveConversation(openMenu, !showArchived);
                setOpenMenu(null);
              }}
              onRename={() => startRename(openMenu, menuConversation.title)}
              onDelete={() => {
                deleteConversation(openMenu);
                setOpenMenu(null);
              }}
            />,
            document.body,
          )
        : null}

      {filesFor ? (
        <SidebarDialog
          title="Files in chat"
          description={fileConversation?.title ?? 'Uploaded files'}
          onClose={() => setFilesFor(null)}
        >
          {uploadedFiles.length === 0 ? (
            <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              No files have been uploaded in this chat yet.
            </p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {uploadedFiles.map((file) => (
                <li
                  key={`${file.messageIndex}-${file.id}`}
                  className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
                    <ActionIcon kind="files" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {file.kind} · {formatBytes(file.sizeBytes)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SidebarDialog>
      ) : null}

    </section>
  );
}

function ConversationAction({
  icon,
  label,
  onClick,
}: {
  icon: 'files' | 'pin' | 'archive';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200"
    >
      <ActionIcon kind={icon} />
      {label}
    </button>
  );
}

/**
 * Per-chat dropdown menu rendered via portal so it can never be clipped by
 * the sidebar's overflow-y-auto container. ``triggerRect`` is the dots
 * button's viewport rect; we anchor the menu to its right edge, place it
 * just below, and flip to opening UPWARD when there isn't enough room
 * below the trigger (e.g. the bottom-most chat in a tall list).
 */
function ConversationMenu({
  menuRef,
  triggerRect,
  conversation,
  showArchived,
  onViewFiles,
  onPin,
  onArchive,
  onRename,
  onDelete,
}: {
  menuRef: React.RefObject<HTMLDivElement>;
  triggerRect: DOMRect;
  conversation: { pinned?: boolean };
  showArchived: boolean;
  onViewFiles: () => void;
  onPin: () => void;
  onArchive: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const MENU_W = 256;
  const MENU_H_APPROX = 220;
  const GAP = 6;

  // Default: open downward, anchored to the trigger's right edge so the
  // menu's right edge tracks the dots-button. Flip upward if the menu would
  // overflow the viewport bottom; flip to the trigger's left edge if it
  // would overflow the viewport right.
  const openUp = triggerRect.bottom + GAP + MENU_H_APPROX > window.innerHeight;
  const top = openUp
    ? Math.max(GAP, triggerRect.top - GAP - MENU_H_APPROX)
    : triggerRect.bottom + GAP;

  let left = triggerRect.right - MENU_W;
  if (left + MENU_W + GAP > window.innerWidth) left = window.innerWidth - MENU_W - GAP;
  if (left < GAP) left = GAP;

  const style: React.CSSProperties = { position: 'fixed', top, left, width: MENU_W };

  return (
    // No role="menu" here: ARIA would then require menuitem children, and
    // our existing actions are <button>s for keyboard + screen-reader
    // accessibility. The dropdown still behaves correctly without the role.
    // Inline style is intentional - top/left/width are computed from the
    // trigger's runtime bounding rect, not part of the design system.
    <div
      ref={menuRef}
      style={style}
      className="z-50 overflow-hidden rounded-3xl border border-neutral-200 bg-white py-2 shadow-[0_24px_60px_-18px_rgba(15,23,42,0.32),0_8px_18px_-8px_rgba(15,23,42,0.18)] dark:border-neutral-700 dark:bg-neutral-900"
    >
      <ConversationAction icon="files" label="View files in chat" onClick={onViewFiles} />
      <ConversationAction icon="pin" label={conversation.pinned ? 'Unpin chat' : 'Pin chat'} onClick={onPin} />
      <ConversationAction icon="archive" label={showArchived ? 'Unarchive' : 'Archive'} onClick={onArchive} />
      <button
        type="button"
        onClick={onRename}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200"
      >
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
          <path d="M4 16l3-1 9-9-2-2-9 9-1 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        Rename
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M5 6h10M8 6V4h4v2m-6 0v10h8V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Delete
      </button>
    </div>
  );
}

function ActionIcon({ kind }: { kind: 'files' | 'pin' | 'archive' }) {
  if (kind === 'files') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M5 4h3l2 12H6.5L5 4zM10 4h3.5L15 16h-3.5L10 4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'pin') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M12 3l5 5-3 1-3.5 3.5.5 3.5-1 1-3-3-3.5 3.5-1-1L6 13l-3-3 1-1 3.5.5L11 6l1-3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 6.5h12M5.5 6.5V16h9V6.5M7 4h6l1 2.5H6L7 4zM8 10h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SidebarDialog({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/35 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)] dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
            <p className="mt-0.5 truncate text-sm text-neutral-500 dark:text-neutral-400" title={description}>
              {description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function collectChatFiles(conversation: { messages?: Message[] } | null | undefined) {
  const files: Array<MessageAttachment & { messageIndex: number }> = [];
  for (const [messageIndex, message] of (conversation?.messages ?? []).entries()) {
    if (!('attachments' in message)) continue;
    for (const attachment of message.attachments ?? []) {
      files.push({ ...attachment, messageIndex });
    }
  }
  return files;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  const collapsed = useChatStore((s) => s.sidebarCollapsed);
  const setCollapsed = useChatStore((s) => s.setSidebarCollapsed);
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

  if (collapsed) return <CollapsedSidebar onExpand={() => setCollapsed(false)} onNewChat={newChat} onSignOut={signOut} />;

  return (
    <aside className="flex h-screen min-h-0 flex-col gap-4 border-r border-neutral-200/70 bg-gradient-to-b from-white via-white to-primary-50/40 px-4 py-5 backdrop-blur-sm dark:border-neutral-800/70 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo size={32} glow />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">PetroBrain</span>
            <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400">
              Operations Copilot
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200/70 bg-white/80 text-neutral-500 transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:text-neutral-400 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
              <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 4v12" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
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
        </div>
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

function CollapsedSidebar({
  onExpand,
  onNewChat,
  onSignOut,
}: {
  onExpand: () => void;
  onNewChat: () => void;
  onSignOut: () => void;
}) {
  const pathname = usePathname();
  const principal = useChatStore((s) => s.principal);
  const initials = principal?.userId.slice(0, 2).toUpperCase() ?? 'PB';

  return (
    <aside className="flex h-screen min-h-0 flex-col items-center gap-1 border-r border-neutral-200/70 bg-gradient-to-b from-white via-white to-primary-50/40 px-2 py-4 backdrop-blur-sm dark:border-neutral-800/70 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className="flex h-10 w-10 items-center justify-center rounded-xl text-neutral-600 transition-colors hover:bg-white/80 hover:text-primary-700 dark:text-neutral-300 dark:hover:bg-neutral-900/70 dark:hover:text-primary-300"
      >
        <Logo size={28} glow />
      </button>

      <button
        type="button"
        onClick={onNewChat}
        disabled={!principal}
        aria-label="New chat"
        title="New chat"
        className="mt-1 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200/70 bg-white/80 text-neutral-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.30)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
      >
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
          <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      <nav className="mt-2 flex flex-col gap-1">
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== '/chat' && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={{ pathname: item.href, query: { from: 'chat' } }}
              aria-label={item.label}
              title={item.label}
              className={clsx(
                'flex h-10 w-10 items-center justify-center rounded-xl transition-all',
                active
                  ? 'bg-gradient-to-br from-primary-500 to-primary-600 text-white shadow-[0_6px_14px_-6px_rgba(234,88,12,0.55)]'
                  : 'text-neutral-600 hover:bg-white hover:text-primary-700 hover:shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-primary-300',
              )}
            >
              <NavIcon kind={item.icon} />
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-white/80 hover:text-primary-700 dark:text-neutral-400 dark:hover:bg-neutral-900/70 dark:hover:text-primary-300"
      >
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 4v12" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {principal ? (
        <button
          type="button"
          onClick={onSignOut}
          aria-label={`Signed in as ${principal.userId}. Click to sign out.`}
          title={`${principal.userId} - sign out`}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-xs font-bold text-white shadow-[0_4px_10px_-3px_rgba(234,88,12,0.5)] transition-transform hover:scale-105"
        >
          {initials}
        </button>
      ) : null}
    </aside>
  );
}
