'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge, Banner, Button, Card, Logo } from '@petrobrain/ui';

import {
  createMemory,
  getFeedbackSummary,
  getFeedbackTrend,
  getGlossaryCandidates,
  getMemoryTrend,
  listChunkWeights,
  listErrors,
  listFeedback,
  listMemory,
  promoteFeedbackToMemory,
  updateMemory,
} from '@/lib/admin-learning/api';
import type {
  ChunkWeightRow,
  ErrorEventRow,
  FeedbackRow,
  FeedbackTrendPoint,
  GlossaryCandidate,
  MemoryKind,
  MemoryRow,
  MemoryTrendPoint,
} from '@/lib/admin-learning/types';
import { MEMORY_KINDS } from '@/lib/admin-learning/types';
import { useChatStore } from '@/lib/chat/store';
import { SessionExpiredError } from '@/lib/chat/streamChat';

/**
 * The Learning page lives inside the chat app at /admin so deployed
 * platform_admins / admins can see what their users have rated, what's
 * being injected into the prompt, and which retrieval chunks have been
 * nudged - without us having to deploy a separate admin app.
 *
 * Scope is THIS tenant only (no ?tenant_id= override). Cross-tenant
 * admin still goes through the backend with a platform_admin token via
 * curl / the admin-console subtree, not from here.
 *
 * Role gating happens client-side (route the user to /chat with a banner
 * if they aren't admin/platform_admin). The backend's role gating is the
 * load-bearing one - the routes themselves return 403 for non-admins.
 */
export function AdminLearningClient() {
  const router = useRouter();
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const hasHydrated = useChatStore((s) => s.hasHydrated);
  const expireSession = useChatStore((s) => s.expireSession);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!token || !principal) {
      router.replace('/signin');
      return;
    }
    if (principal.role !== 'admin' && principal.role !== 'platform_admin') {
      router.replace('/chat');
    }
  }, [hasHydrated, token, principal, router]);

  if (!hasHydrated) {
    return (
      <main className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30">
        <Logo size={40} glow />
      </main>
    );
  }
  if (!token || !principal) return null;
  if (principal.role !== 'admin' && principal.role !== 'platform_admin') return null;

  return (
    <LearningView
      token={token}
      apiBaseUrl={apiBaseUrl}
      role={principal.role}
      tenantId={principal.tenantId}
      userId={principal.userId}
      onSessionExpired={() => expireSession('expired')}
      onBack={() => router.push('/chat')}
    />
  );
}

function LearningView({
  token,
  apiBaseUrl,
  role,
  tenantId,
  userId,
  onSessionExpired,
  onBack,
}: {
  token: string;
  apiBaseUrl: string;
  role: string;
  tenantId: string;
  userId: string;
  onSessionExpired: () => void;
  onBack: () => void;
}) {
  const auth = { baseUrl: apiBaseUrl, token };

  const summary = useQuery({
    queryKey: ['admin-learning', 'summary'],
    queryFn: ({ signal }) => getFeedbackSummary({ ...auth, signal }),
  });
  const feedback = useQuery({
    queryKey: ['admin-learning', 'feedback'],
    queryFn: ({ signal }) => listFeedback({ ...auth, signal, limit: 50 }),
  });
  const memories = useQuery({
    queryKey: ['admin-learning', 'memories'],
    queryFn: ({ signal }) =>
      listMemory({ ...auth, signal, status: 'active', limit: 100 }),
  });
  const weights = useQuery({
    queryKey: ['admin-learning', 'weights'],
    queryFn: ({ signal }) => listChunkWeights({ ...auth, signal, limit: 50 }),
  });
  const feedbackTrend = useQuery({
    queryKey: ['admin-learning', 'feedback-trend'],
    queryFn: ({ signal }) => getFeedbackTrend({ ...auth, signal, days: 30 }),
  });
  const memoryTrend = useQuery({
    queryKey: ['admin-learning', 'memory-trend'],
    queryFn: ({ signal }) => getMemoryTrend({ ...auth, signal, weeks: 12 }),
  });
  const glossary = useQuery({
    queryKey: ['admin-learning', 'glossary'],
    queryFn: ({ signal }) =>
      getGlossaryCandidates({ ...auth, signal, minCount: 2 }),
  });
  // Errors are the only section that polls aggressively (8s vs the rest at
  // staleTime 30s default) - the user wants "no delays" so admins see live
  // failures in seconds, not minutes. Polling pauses while the tab is
  // hidden so a background tab isn't hammering the API.
  const errors = useQuery({
    queryKey: ['admin-learning', 'errors'],
    queryFn: ({ signal }) => listErrors({ ...auth, signal, limit: 25 }),
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
  });

  // If anything came back with a SessionExpiredError, clear the session
  // exactly like the chat path does. The user lands on /signin with the
  // friendly banner.
  useEffect(() => {
    const errs = [
      summary.error, feedback.error, memories.error, weights.error,
      feedbackTrend.error, memoryTrend.error, glossary.error, errors.error,
    ];
    if (errs.some((e) => e instanceof SessionExpiredError)) {
      onSessionExpired();
    }
  }, [summary.error, feedback.error, memories.error, weights.error,
      feedbackTrend.error, memoryTrend.error, glossary.error, errors.error, onSessionExpired]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
      <header className="sticky top-0 z-30 border-b border-neutral-200/60 bg-white/70 backdrop-blur-xl dark:border-neutral-800/60 dark:bg-neutral-950/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-200/70 bg-white/80 px-3 text-sm font-medium text-neutral-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.25)] dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
              aria-label="Back to chat"
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                <path d="M12 5l-5 5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Chat
            </button>
            <div className="flex min-w-0 items-center gap-2">
              <Logo size={28} glow />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  PetroBrain - Admin
                </span>
                <span className="hidden text-[10px] font-medium uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400 md:inline">
                  Learning Console
                </span>
              </div>
            </div>
          </div>
          <RoleBadge role={role} tenantId={tenantId} userId={userId} />
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="relative isolate overflow-hidden rounded-3xl border border-primary-200/60 bg-gradient-to-br from-primary-50/80 via-white to-white p-6 shadow-[0_18px_45px_-18px_rgba(234,88,12,0.22),inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-primary-800/40 dark:from-primary-900/30 dark:via-neutral-900 dark:to-neutral-900">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary-200/40 blur-3xl dark:bg-primary-700/20" aria-hidden />
          <div className="relative space-y-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary-200 bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary-700 dark:border-primary-700/40 dark:bg-primary-900/30 dark:text-primary-200">
              <span className="h-1 w-1 rounded-full bg-primary-500" aria-hidden />
              Learning
            </span>
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              What your team is teaching the system
            </h1>
            <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
              Feedback, memory, and retrieval signal - scoped to your tenant,
              never shared across tenants.
            </p>
          </div>
        </header>

        <SummaryCards
          feedbackTotal={summary.data?.total ?? 0}
          feedbackUp={summary.data?.up ?? 0}
          feedbackDown={summary.data?.down ?? 0}
          activeMemories={memories.data?.memories.length ?? 0}
          weightedChunks={weights.data?.weights.length ?? 0}
        />

        <TrendsSection
          feedback={feedbackTrend.data?.series ?? []}
          memory={memoryTrend.data?.series ?? []}
          loading={feedbackTrend.isLoading || memoryTrend.isLoading}
          error={feedbackTrend.error ?? memoryTrend.error}
        />

        <ErrorsSection
          rows={errors.data?.errors ?? []}
          loading={errors.isLoading}
          error={errors.error}
        />

        <FeedbackSection
          rows={feedback.data?.feedback ?? []}
          loading={feedback.isLoading}
          error={feedback.error}
          auth={auth}
        />

        <MemorySection
          rows={memories.data?.memories ?? []}
          loading={memories.isLoading}
          error={memories.error}
          auth={auth}
        />

        <GlossarySection
          candidates={glossary.data?.candidates ?? []}
          loading={glossary.isLoading}
          error={glossary.error}
          auth={auth}
        />

        <ChunkWeightsSection
          rows={weights.data?.weights ?? []}
          loading={weights.isLoading}
          error={weights.error}
        />
      </div>
    </main>
  );
}

// ---- Summary cards -----------------------------------------------------

// ---- Role badge --------------------------------------------------------

/**
 * Pill in the top-right that makes the admin's identity + tenant explicit.
 * This is the "add auth to the admin page" follow-up: the page WAS gated
 * before (non-admin -> /chat redirect) but the gating was invisible. Now
 * the admin always sees who they're acting as. Also clarifies why a
 * platform_admin sees the same view across tenants - they're identified
 * with a distinct gradient pill.
 */
function RoleBadge({
  role,
  tenantId,
  userId,
}: {
  role: string;
  tenantId: string;
  userId: string;
}) {
  const isPlatform = role === 'platform_admin';
  return (
    <div
      className={
        isPlatform
          ? 'inline-flex items-center gap-2 rounded-full border border-primary-300 bg-gradient-to-r from-primary-100/80 to-primary-200/40 px-3 py-1 text-xs font-medium text-primary-900 shadow-[0_4px_14px_-4px_rgba(234,88,12,0.35),inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-primary-600/60 dark:from-primary-700/40 dark:to-primary-800/30 dark:text-primary-100'
          : 'inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/90 px-3 py-1 text-xs font-medium text-neutral-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-200'
      }
      title={`Signed in as ${userId} (${role}) - tenant ${tenantId}`}
    >
      <span
        className={
          isPlatform
            ? 'h-2 w-2 rounded-full bg-primary-500 shadow-[0_0_8px_rgba(234,88,12,0.6)]'
            : 'h-2 w-2 rounded-full bg-green-500'
        }
        aria-hidden
      />
      <span className="font-semibold uppercase tracking-[0.06em]">
        {isPlatform ? 'Platform admin' : 'Tenant admin'}
      </span>
      <span className="hidden text-neutral-500 dark:text-neutral-400 sm:inline">
        · {tenantId}
      </span>
    </div>
  );
}

// ---- Custom dropdown (replaces native <select>) -----------------------

/**
 * Brand-styled dropdown for MemoryKind. Replaces native <select> so the
 * dropdown shell, hover/active states, and popover all use the PetroBrain
 * palette instead of the OS's grey-on-grey rendering.
 *
 * Keyboard accessibility intentionally minimal (Esc to close, click out to
 * close). The choices are a fixed 3-element set, so arrow-key navigation
 * is a nice-to-have we haven't paid for yet.
 */
function KindDropdown({
  id,
  value,
  onChange,
  label,
  placement = 'bottom',
}: {
  id?: string;
  value: MemoryKind;
  onChange: (k: MemoryKind) => void;
  label: string;
  placement?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Note: deliberately NOT using aria-haspopup="listbox" / role="option" /
  // aria-selected here. Those ARIA roles require a particular DOM
  // contract (role=listbox parent, role=option children, aria-activedescendant
  // pattern) that our 3-button popup doesn't pay for fully. The static
  // analyser flags any partial implementation as an a11y error, and a
  // partial ARIA contract is worse than none. The dropdown remains
  // keyboard-accessible (buttons are focusable, Esc closes, click-outside
  // closes) and screen readers announce each button's label correctly.
  return (
    <div ref={rootRef} className="relative mt-1">
      <button
        id={id}
        type="button"
        aria-label={`${label}: ${value}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-xl border border-neutral-200 bg-white/90 px-3 py-2 text-sm font-medium text-neutral-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 hover:text-primary-700 focus:outline-none focus-visible:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:border-primary-600 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-800"
      >
        <span className="flex items-center gap-2">
          <KindGlyph kind={value} />
          <span className="capitalize">{value}</span>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          aria-label={label}
          className={`absolute left-0 right-0 z-[80] overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-[0_18px_45px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] dark:border-neutral-700 dark:bg-neutral-900 ${
            placement === 'top' ? 'bottom-full mb-1' : 'mt-1'
          }`}
        >
          {MEMORY_KINDS.map((k) => {
            const selected = k === value;
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  onChange(k);
                  setOpen(false);
                }}
                className={
                  selected
                    ? 'flex w-full items-center gap-2.5 bg-primary-50/70 px-3 py-2 text-left text-sm font-medium text-primary-700 dark:bg-primary-900/30 dark:text-primary-200'
                    : 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-primary-50/60 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200'
                }
              >
                <KindGlyph kind={k} />
                <span className="flex-1 capitalize">{k}</span>
                {selected ? (
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function KindGlyph({ kind }: { kind: MemoryKind }) {
  if (kind === 'terminology') {
    // Book / glossary glyph.
    return (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden className="text-primary-600 dark:text-primary-400">
        <path d="M4 4h6a2 2 0 012 2v10H6a2 2 0 01-2-2V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M16 4h-6a2 2 0 00-2 2v10h6a2 2 0 002-2V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'preference') {
    return (
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden className="text-primary-600 dark:text-primary-400">
        <path d="M10 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 15.4 5.2 17.9l.9-5.4-3.9-3.8 5.4-.8L10 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  // context
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden className="text-primary-600 dark:text-primary-400">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6.5v4M10 13.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SummaryCards({
  feedbackTotal,
  feedbackUp,
  feedbackDown,
  activeMemories,
  weightedChunks,
}: {
  feedbackTotal: number;
  feedbackUp: number;
  feedbackDown: number;
  activeMemories: number;
  weightedChunks: number;
}) {
  const netSignal = feedbackUp - feedbackDown;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      <SummaryCard
        accent="primary"
        title="Feedback collected"
        primary={feedbackTotal.toLocaleString()}
        secondary={`👍 ${feedbackUp.toLocaleString()} · 👎 ${feedbackDown.toLocaleString()}`}
      />
      <SummaryCard
        accent="neutral"
        title="Active memories"
        primary={activeMemories.toLocaleString()}
        secondary="Injected into every chat turn"
      />
      <SummaryCard
        accent="neutral"
        title="Weighted chunks"
        primary={weightedChunks.toLocaleString()}
        secondary="Retrieval rank nudged by feedback"
      />
      <SummaryCard
        accent={netSignal >= 0 ? 'positive' : 'negative'}
        title="Net signal"
        primary={`${netSignal >= 0 ? '+' : ''}${netSignal}`}
        secondary={
          feedbackTotal > 0
            ? `${Math.round((feedbackUp / feedbackTotal) * 100)}% positive`
            : 'No feedback yet'
        }
      />
    </div>
  );
}

function SummaryCard({
  title,
  primary,
  secondary,
  accent = 'neutral',
}: {
  title: string;
  primary: string;
  secondary: string;
  accent?: 'primary' | 'neutral' | 'positive' | 'negative';
}) {
  // Subtle accent stripe on the top edge of each card so the eye can
  // sweep across the row and pick out the categories without the values
  // being bigger or louder than they need to be.
  const accentStripe =
    accent === 'primary'
      ? 'before:bg-gradient-to-r before:from-primary-400 before:to-primary-600'
      : accent === 'positive'
        ? 'before:bg-gradient-to-r before:from-emerald-400 before:to-green-600'
        : accent === 'negative'
          ? 'before:bg-gradient-to-r before:from-rose-400 before:to-red-600'
          : 'before:bg-gradient-to-r before:from-neutral-300 before:to-neutral-400 dark:before:from-neutral-700 dark:before:to-neutral-600';
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/90 p-4 shadow-[0_2px_4px_rgba(15,23,42,0.04)] backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-[0_18px_45px_-18px_rgba(234,88,12,0.18)] dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-700/40 before:absolute before:left-0 before:right-0 before:top-0 before:h-[3px] ${accentStripe}`}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
        {title}
      </p>
      <p className="mt-1 text-2xl font-semibold text-neutral-800 dark:text-neutral-100">
        {primary}
      </p>
      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
        {secondary}
      </p>
    </div>
  );
}

// ---- Trends ------------------------------------------------------------

function TrendsSection({
  feedback,
  memory,
  loading,
  error,
}: {
  feedback: FeedbackTrendPoint[];
  memory: MemoryTrendPoint[];
  loading: boolean;
  error: unknown;
}) {
  return (
    <Card
      title="Trends"
      description="Daily 👍 / 👎 over 30 days, weekly memory additions over 12 weeks."
    >
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load trends">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <FeedbackTrendChart series={feedback} />
        <MemoryTrendChart series={memory} />
      </div>
    </Card>
  );
}

function FeedbackTrendChart({ series }: { series: FeedbackTrendPoint[] }) {
  if (series.length === 0) return null;
  const w = 360;
  const h = 110;
  const padL = 20;
  const padR = 4;
  const padT = 10;
  const padB = 18;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const max = Math.max(1, ...series.map((p) => p.up + p.down));
  const barW = Math.max(2, innerW / series.length - 2);
  const totalUp = series.reduce((acc, p) => acc + p.up, 0);
  const totalDown = series.reduce((acc, p) => acc + p.down, 0);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
        Feedback per day · 30d
      </p>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`Feedback per day. ${totalUp} thumbs up, ${totalDown} thumbs down across the window.`}
      >
        <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#e5e7eb" />
        {series.map((p, i) => {
          const x = padL + (i * innerW) / series.length + 1;
          const totalForDay = p.up + p.down;
          const totalHeight = totalForDay > 0 ? (totalForDay / max) * innerH : 0;
          const downHeight = totalForDay > 0 ? (p.down / max) * innerH : 0;
          const upHeight = totalHeight - downHeight;
          const yTop = padT + innerH - totalHeight;
          return (
            <g key={p.day}>
              {p.down > 0 ? (
                <rect x={x} y={padT + innerH - downHeight} width={barW} height={downHeight} fill="#dc2626" fillOpacity={0.7} />
              ) : null}
              {p.up > 0 ? (
                <rect x={x} y={yTop} width={barW} height={upHeight} fill="#16a34a" fillOpacity={0.7} />
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-neutral-500">
        <span className="font-medium text-green-700">👍 {totalUp}</span>
        {' · '}
        <span className="font-medium text-red-700">👎 {totalDown}</span>
        {' total in window'}
      </p>
    </div>
  );
}

function MemoryTrendChart({ series }: { series: MemoryTrendPoint[] }) {
  if (series.length === 0) return null;
  const w = 360;
  const h = 110;
  const padL = 20;
  const padR = 4;
  const padT = 10;
  const padB = 18;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const max = Math.max(1, ...series.map((p) => p.manual + p.promoted));
  const barW = Math.max(4, innerW / series.length - 4);
  const totalManual = series.reduce((acc, p) => acc + p.manual, 0);
  const totalPromoted = series.reduce((acc, p) => acc + p.promoted, 0);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
        Memories added per week · 12w
      </p>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`Memory additions per week. ${totalManual} manual, ${totalPromoted} promoted from feedback across the window.`}
      >
        <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#e5e7eb" />
        {series.map((p, i) => {
          const x = padL + (i * innerW) / series.length + 2;
          const total = p.manual + p.promoted;
          const totalHeight = total > 0 ? (total / max) * innerH : 0;
          const manualHeight = total > 0 ? (p.manual / max) * innerH : 0;
          const promotedHeight = totalHeight - manualHeight;
          const yTop = padT + innerH - totalHeight;
          return (
            <g key={p.week_start}>
              {p.manual > 0 ? (
                <rect x={x} y={padT + innerH - manualHeight} width={barW} height={manualHeight} fill="#a3a3a3" fillOpacity={0.7} />
              ) : null}
              {p.promoted > 0 ? (
                <rect x={x} y={yTop} width={barW} height={promotedHeight} fill="#ea580c" fillOpacity={0.8} />
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-neutral-500">
        <span className="font-medium text-primary-600">{totalPromoted} promoted</span>
        {' · '}
        <span className="font-medium text-neutral-500">{totalManual} manual</span>
        {' in window'}
      </p>
    </div>
  );
}

// ---- User-visible errors ----------------------------------------------

function ErrorsSection({
  rows,
  loading,
  error,
}: {
  rows: ErrorEventRow[];
  loading: boolean;
  error: unknown;
}) {
  return (
    <Card
      title="User-visible errors"
      description="Latest failed user actions reported by the app. Prompts and raw chat text are not stored here."
    >
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load errors">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading...</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No reported user-visible errors yet.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => (
            <ErrorRowItem key={row.id} row={row} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function ErrorRowItem({ row }: { row: ErrorEventRow }) {
  const when = safeDate(row.created_utc);
  return (
    <article className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={row.status && row.status >= 500 ? 'danger' : 'warn'}>
            {row.status ? `${row.status}` : 'client'}
          </Badge>
          <span className="truncate text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {row.route}
          </span>
          <span className="text-[11px] text-neutral-400">
            {when}
          </span>
        </div>
        <p className="break-words text-sm text-neutral-800 dark:text-neutral-100">
          {row.message}
        </p>
      </div>
      <div className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 md:text-right">
        <p className="font-medium">{row.role}</p>
        <p className="max-w-[12rem] truncate" title={row.user_id}>{row.user_id}</p>
      </div>
    </article>
  );
}

function safeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

// ---- Feedback section --------------------------------------------------

function FeedbackSection({
  rows,
  loading,
  error,
  auth,
}: {
  rows: FeedbackRow[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string };
}) {
  const qc = useQueryClient();
  const [promoting, setPromoting] = useState<FeedbackRow | null>(null);
  const [promoteBody, setPromoteBody] = useState('');
  const [promoteKind, setPromoteKind] = useState<MemoryKind>('preference');
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const promoteMutation = useMutation({
    mutationFn: () =>
      promoteFeedbackToMemory({
        baseUrl: auth.baseUrl,
        token: auth.token,
        feedbackId: promoting!.id,
        body: promoteBody,
        kind: promoteKind,
      }),
    onSuccess: () => {
      setPromoting(null);
      setPromoteBody('');
      setPromoteKind('preference');
      setPromoteError(null);
      qc.invalidateQueries({ queryKey: ['admin-learning', 'memories'] });
      qc.invalidateQueries({ queryKey: ['admin-learning', 'summary'] });
      qc.invalidateQueries({ queryKey: ['admin-learning', 'glossary'] });
    },
    onError: (err) => setPromoteError((err as Error).message),
  });

  function startPromote(row: FeedbackRow) {
    setPromoting(row);
    setPromoteBody(row.reason ?? '');
    setPromoteKind('preference');
    setPromoteError(null);
  }

  return (
    <Card title="Feedback stream" description="Latest 👍 / 👎 from your chat users.">
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load feedback">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No feedback yet. Once users start rating chat turns, ratings + reasons appear here.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => (
            <FeedbackRowItem key={row.id} row={row} onPromote={startPromote} />
          ))}
        </div>
      ) : null}
      {promoting ? (
        <PromoteDialog
          row={promoting}
          body={promoteBody}
          setBody={setPromoteBody}
          kind={promoteKind}
          setKind={setPromoteKind}
          error={promoteError}
          submitting={promoteMutation.isPending}
          onCancel={() => {
            setPromoting(null);
            setPromoteError(null);
          }}
          onSubmit={() => {
            if (!promoteBody.trim()) {
              setPromoteError('Memory body cannot be empty.');
              return;
            }
            promoteMutation.mutate();
          }}
        />
      ) : null}
    </Card>
  );
}

function FeedbackRowItem({
  row,
  onPromote,
}: {
  row: FeedbackRow;
  onPromote: (row: FeedbackRow) => void;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="text-lg leading-none">{row.rating === 'up' ? '👍' : '👎'}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>{new Date(row.created_utc).toLocaleString()}</span>
          <span>·</span>
          <span>user {row.user_id}</span>
          {row.module ? (
            <>
              <span>·</span>
              <Badge tone="neutral">{row.module}</Badge>
            </>
          ) : null}
        </div>
        {row.reason ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-200">
            {row.reason}
          </p>
        ) : (
          <p className="mt-1 text-sm italic text-neutral-400">No reason provided.</p>
        )}
      </div>
      {row.rating === 'down' && row.reason ? (
        <Button size="sm" variant="ghost" onClick={() => onPromote(row)}>
          Promote to memory
        </Button>
      ) : null}
    </div>
  );
}

function PromoteDialog({
  row,
  body,
  setBody,
  kind,
  setKind,
  error,
  submitting,
  onCancel,
  onSubmit,
}: {
  row: FeedbackRow;
  body: string;
  setBody: (v: string) => void;
  kind: MemoryKind;
  setKind: (k: MemoryKind) => void;
  error: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
        <h3 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
          Promote feedback to memory
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          The text you write below is what will be injected into every chat
          turn for your tenant. Rewrite the user&apos;s raw reason into one
          safe sentence. Keep it under 280 characters.
        </p>
        <div className="mt-3 rounded-md bg-neutral-50 p-2 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          <span className="font-medium">User said:</span> {row.reason}
        </div>
        <label
          htmlFor={`promote-body-${row.id}`}
          className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-neutral-500"
        >
          Memory body
        </label>
        <textarea
          id={`promote-body-${row.id}`}
          aria-label="Memory body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={280}
          placeholder="e.g. We call wellhead pressure 'WHP' on Asset-A."
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <div className="mt-1 text-right text-[10px] text-neutral-400">{body.length} / 280</div>
        <div className="mt-2">
          <p className="block text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
            Kind
          </p>
          <KindDropdown
            id={`promote-kind-${row.id}`}
            value={kind}
            onChange={setKind}
            label="Memory kind"
          />
        </div>
        {error ? <p className="mt-2 text-xs text-danger-fg">{error}</p> : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save memory'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Memory section ----------------------------------------------------

function MemorySection({
  rows,
  loading,
  error,
  auth,
}: {
  rows: MemoryRow[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string };
}) {
  const qc = useQueryClient();
  const [newBody, setNewBody] = useState('');
  const [newKind, setNewKind] = useState<MemoryKind>('preference');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createMemory({
        baseUrl: auth.baseUrl,
        token: auth.token,
        body: newBody,
        kind: newKind,
      }),
    onSuccess: () => {
      setNewBody('');
      setNewKind('preference');
      setCreateError(null);
      qc.invalidateQueries({ queryKey: ['admin-learning', 'memories'] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) =>
      updateMemory({
        baseUrl: auth.baseUrl,
        token: auth.token,
        memoryId: id,
        status: 'archived',
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin-learning', 'memories'] }),
  });

  return (
    <Card
      title="Active memories"
      description="One-line preferences injected into every chat turn. Subordinate to base safety rules."
    >
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load memories">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No active memories. Promote a 👎 feedback row above, or add a manual one below.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 py-3">
              <Badge tone="neutral">{row.kind}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-800 dark:text-neutral-100">{row.body}</p>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  added {new Date(row.created_utc).toLocaleDateString()} · by {row.created_by}
                  {row.source === 'promoted_feedback' ? ' · from feedback' : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => archiveMutation.mutate(row.id)}
                disabled={archiveMutation.isPending}
              >
                Archive
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <p className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
          Add a new memory
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[16rem]">
            <input
              aria-label="New memory body"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              maxLength={280}
              placeholder="e.g. Default units are metric on Bono-1."
              className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
          <div className="w-[10rem]">
            <KindDropdown
              value={newKind}
              onChange={setNewKind}
              label="New memory kind"
              placement="top"
            />
          </div>
          <Button
            onClick={() => {
              if (!newBody.trim()) {
                setCreateError('Memory body cannot be empty.');
                return;
              }
              createMutation.mutate();
            }}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? 'Saving…' : 'Add'}
          </Button>
        </div>
        {createError ? <p className="mt-2 text-xs text-danger-fg">{createError}</p> : null}
      </div>
    </Card>
  );
}

// ---- Glossary candidates ----------------------------------------------

function GlossarySection({
  candidates,
  loading,
  error,
  auth,
}: {
  candidates: GlossaryCandidate[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string };
}) {
  const qc = useQueryClient();
  const [approving, setApproving] = useState<GlossaryCandidate | null>(null);
  const [body, setBody] = useState('');
  const [approveError, setApproveError] = useState<string | null>(null);

  const approveMutation = useMutation({
    mutationFn: () =>
      createMemory({
        baseUrl: auth.baseUrl,
        token: auth.token,
        body,
        kind: 'terminology',
      }),
    onSuccess: () => {
      setApproving(null);
      setBody('');
      setApproveError(null);
      qc.invalidateQueries({ queryKey: ['admin-learning', 'memories'] });
      qc.invalidateQueries({ queryKey: ['admin-learning', 'glossary'] });
    },
    onError: (err) => setApproveError((err as Error).message),
  });

  function startApprove(c: GlossaryCandidate) {
    setApproving(c);
    setBody(`We use the term "${c.term}" on this asset.`);
    setApproveError(null);
  }

  return (
    <Card
      title="Glossary candidates"
      description="Terms that recur across your memories. Approving one creates a terminology memory."
    >
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load glossary candidates">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && candidates.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No recurring terms yet. As more memories land, terms that appear
          across two or more will show up here for one-click approval.
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {candidates.map((c) => (
            <li
              key={c.term}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  {c.term}
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  mentioned in {c.count} {c.count === 1 ? 'memory' : 'memories'}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => startApprove(c)}>
                Approve as glossary entry
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {approving ? (
        <ApproveGlossaryDialog
          candidate={approving}
          body={body}
          setBody={setBody}
          error={approveError}
          submitting={approveMutation.isPending}
          onCancel={() => {
            setApproving(null);
            setApproveError(null);
          }}
          onSubmit={() => {
            if (!body.trim()) {
              setApproveError('Memory body cannot be empty.');
              return;
            }
            approveMutation.mutate();
          }}
        />
      ) : null}
    </Card>
  );
}

function ApproveGlossaryDialog({
  candidate,
  body,
  setBody,
  error,
  submitting,
  onCancel,
  onSubmit,
}: {
  candidate: GlossaryCandidate;
  body: string;
  setBody: (v: string) => void;
  error: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
        <h3 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
          Approve glossary entry
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Saving creates a <strong>terminology</strong> memory that gets
          injected into every future chat turn for your tenant. Phrase it as
          a sentence the model can use, not just the bare term.
        </p>
        <div className="mt-3 rounded-md bg-neutral-50 p-2 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          <span className="font-medium">Recurring term:</span>{' '}
          <span className="font-mono">{candidate.term}</span>
          {' · seen in '}
          {candidate.count} {candidate.count === 1 ? 'memory' : 'memories'}
        </div>
        <label
          htmlFor={`glossary-body-${candidate.term}`}
          className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-neutral-500"
        >
          Memory body
        </label>
        <textarea
          id={`glossary-body-${candidate.term}`}
          aria-label="Memory body for glossary entry"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={280}
          placeholder={`e.g. We use the term "${candidate.term}" on this asset.`}
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <div className="mt-1 text-right text-[10px] text-neutral-400">{body.length} / 280</div>
        {error ? <p className="mt-2 text-xs text-danger-fg">{error}</p> : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save glossary entry'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Chunk weights -----------------------------------------------------

const CHUNK_WEIGHT_FLOOR = 0.5;
const FLOOR_EPSILON = 0.005;

function isAtFloor(weight: number): boolean {
  return weight <= CHUNK_WEIGHT_FLOOR + FLOOR_EPSILON;
}

function ChunkWeightsSection({
  rows,
  loading,
  error,
}: {
  rows: ChunkWeightRow[];
  loading: boolean;
  error: unknown;
}) {
  const [showOnlyFloor, setShowOnlyFloor] = useState(false);
  const floorRows = rows.filter((r) => isAtFloor(r.weight));
  const visible = showOnlyFloor ? floorRows : rows;

  return (
    <Card
      title="Retrieval weights"
      description="Per-tenant nudges applied after hybrid search, before rerank. Bounded [0.5, 1.5] - no amount of feedback can hide a chunk."
    >
      {error && !(error instanceof SessionExpiredError) ? (
        <Banner tone="danger" title="Failed to load chunk weights">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No retrieval signal yet. Once users rate chat turns that cite
          documents, the chunks involved show up here with their weight + thumbs counts.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <>
          {floorRows.length > 0 ? (
            <div className="mb-3 flex items-start gap-3 rounded-md border border-danger-border bg-danger-bg/50 p-3 text-xs text-danger-fg">
              <div className="mt-0.5">⚠️</div>
              <div className="flex-1">
                <p className="font-medium">
                  {floorRows.length} {floorRows.length === 1 ? 'chunk has' : 'chunks have'} hit
                  the safety floor (weight = {CHUNK_WEIGHT_FLOOR.toFixed(1)}).
                </p>
                <p className="mt-0.5">
                  These chunks accumulated enough negative feedback to be demoted as far as the
                  system allows. Decide per chunk: rewrite the source SOP, replace the document,
                  or remove the chunk from the corpus. Capped negative feedback alone will not
                  hide them from retrieval.
                </p>
              </div>
              <Button
                size="sm"
                variant={showOnlyFloor ? 'primary' : 'ghost'}
                onClick={() => setShowOnlyFloor((v) => !v)}
              >
                {showOnlyFloor ? 'Show all' : 'Investigate'}
              </Button>
            </div>
          ) : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-[0.06em] text-neutral-500 dark:border-neutral-800">
                <th className="py-2 pr-3">Chunk</th>
                <th className="py-2 pr-3">Weight</th>
                <th className="py-2 pr-3">👍</th>
                <th className="py-2 pr-3">👎</th>
                <th className="py-2">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.chunk_id}
                  className={
                    isAtFloor(row.weight)
                      ? 'border-b border-danger-border/40 bg-danger-bg/10'
                      : 'border-b border-neutral-100 dark:border-neutral-800'
                  }
                >
                  <td className="py-2 pr-3 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                    {row.chunk_id}
                    {isAtFloor(row.weight) ? (
                      <Badge tone="danger" className="ml-2">
                        at floor
                      </Badge>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <WeightBar weight={row.weight} />
                  </td>
                  <td className="py-2 pr-3 text-neutral-700 dark:text-neutral-300">{row.up_count}</td>
                  <td className="py-2 pr-3 text-neutral-700 dark:text-neutral-300">{row.down_count}</td>
                  <td className="py-2 text-xs text-neutral-500">
                    {new Date(row.last_updated).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Card>
  );
}

function WeightBar({ weight }: { weight: number }) {
  const clamped = Math.max(0.5, Math.min(1.5, weight));
  const pctFromCenter = ((clamped - 1.0) / 0.5) * 50;
  const isDown = clamped < 1.0;
  // Inline style is intentional: bar width is data-driven (per row weight),
  // can't be a static class.
  const barStyle = isDown
    ? { right: '50%', width: `${Math.abs(pctFromCenter)}%` }
    : { left: '50%', width: `${pctFromCenter}%` };
  return (
    <div
      className="flex items-center gap-2"
      title={`weight ${clamped.toFixed(2)} (${isDown ? 'demoted' : 'boosted'})`}
    >
      <div className="relative h-2 w-24 rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div className="absolute left-1/2 top-0 h-2 w-px bg-neutral-300 dark:bg-neutral-600" />
        <div
          className={
            isDown
              ? 'absolute top-0 h-2 rounded-full bg-danger-fg/60'
              : 'absolute top-0 h-2 rounded-full bg-primary-600/70'
          }
          style={barStyle}
        />
      </div>
      <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
        {clamped.toFixed(2)}
      </span>
    </div>
  );
}
