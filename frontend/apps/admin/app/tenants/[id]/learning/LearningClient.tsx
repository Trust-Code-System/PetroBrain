'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge, Banner, Button, Card } from '@petrobrain/ui';

import {
  createMemory,
  getFeedbackSummary,
  getFeedbackTrend,
  getGlossaryCandidates,
  getMemoryTrend,
  listChunkWeights,
  listFeedback,
  listMemory,
  promoteFeedbackToMemory,
  updateMemory,
} from '@/lib/admin-console/api';
import type {
  ChunkWeightRow,
  FeedbackRow,
  FeedbackTrendPoint,
  GlossaryCandidate,
  MemoryKind,
  MemoryRow,
  MemoryTrendPoint,
} from '@/lib/admin-console/types';
import { MEMORY_KINDS } from '@/lib/admin-console/types';
import { useAdminSession } from '@/lib/session/store';

import { AdminShell } from '../../../AdminShell';
import { AuthGate } from '../../../AuthGate';

/**
 * Per-tenant Learning page: one screen that surfaces the entire feedback loop.
 *
 * Sections (top to bottom):
 *   1. Summary cards - thumbs counts, active memories, weighted chunks.
 *   2. Feedback stream - latest 👍/👎 with reasons; promote-to-memory on 👎.
 *   3. Active memories - what's currently injected into the system prompt;
 *      archive button per row.
 *   4. Chunk weights - retrieval ranking nudges, sorted by weight (most-
 *      penalised first). Read-only - writes only happen via feedback so
 *      every weight change traces back to a turn.
 */
export function LearningClient({ tenantId }: { tenantId: string }) {
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
          Use a platform_admin token to read another tenant&apos;s learning loop.
        </Banner>
      </AdminShell>
    );
  }

  return <LearningView tenantId={tenantId} token={token} apiBaseUrl={apiBaseUrl} />;
}

function LearningView({
  tenantId,
  token,
  apiBaseUrl,
}: {
  tenantId: string;
  token: string;
  apiBaseUrl: string;
}) {
  const auth = { baseUrl: apiBaseUrl, token, tenantId };

  const summary = useQuery({
    queryKey: ['learning', tenantId, 'summary'],
    queryFn: ({ signal }) => getFeedbackSummary({ ...auth, signal }),
  });
  const feedback = useQuery({
    queryKey: ['learning', tenantId, 'feedback'],
    queryFn: ({ signal }) => listFeedback({ ...auth, signal, limit: 50 }),
  });
  const memories = useQuery({
    queryKey: ['learning', tenantId, 'memories'],
    queryFn: ({ signal }) => listMemory({ ...auth, signal, status: 'active', limit: 100 }),
  });
  const weights = useQuery({
    queryKey: ['learning', tenantId, 'weights'],
    queryFn: ({ signal }) => listChunkWeights({ ...auth, signal, limit: 50 }),
  });
  const feedbackTrend = useQuery({
    queryKey: ['learning', tenantId, 'feedback-trend'],
    queryFn: ({ signal }) => getFeedbackTrend({ ...auth, signal, days: 30 }),
  });
  const memoryTrend = useQuery({
    queryKey: ['learning', tenantId, 'memory-trend'],
    queryFn: ({ signal }) => getMemoryTrend({ ...auth, signal, weeks: 12 }),
  });
  const glossary = useQuery({
    queryKey: ['learning', tenantId, 'glossary'],
    queryFn: ({ signal }) => getGlossaryCandidates({ ...auth, signal, minCount: 2 }),
  });

  return (
    <AdminShell
      title="Learning"
      subtitle="What the system has learned from your team's feedback - per tenant, never shared across tenants."
    >
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

      <FeedbackSection
        tenantId={tenantId}
        rows={feedback.data?.feedback ?? []}
        loading={feedback.isLoading}
        error={feedback.error}
        auth={auth}
      />

      <MemorySection
        tenantId={tenantId}
        rows={memories.data?.memories ?? []}
        loading={memories.isLoading}
        error={memories.error}
        auth={auth}
      />

      <GlossarySection
        tenantId={tenantId}
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
    </AdminShell>
  );
}

// ---- Summary cards -----------------------------------------------------

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
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      <SummaryCard
        title="Feedback collected"
        primary={feedbackTotal.toLocaleString()}
        secondary={`👍 ${feedbackUp.toLocaleString()} · 👎 ${feedbackDown.toLocaleString()}`}
      />
      <SummaryCard
        title="Active memories"
        primary={activeMemories.toLocaleString()}
        secondary="Injected into every chat turn"
      />
      <SummaryCard
        title="Weighted chunks"
        primary={weightedChunks.toLocaleString()}
        secondary="Retrieval rank nudged by feedback"
      />
      <SummaryCard
        title="Net signal"
        primary={`${feedbackUp - feedbackDown >= 0 ? '+' : ''}${feedbackUp - feedbackDown}`}
        secondary={feedbackTotal > 0
          ? `${Math.round((feedbackUp / feedbackTotal) * 100)}% positive`
          : 'No feedback yet'}
      />
    </div>
  );
}

function SummaryCard({
  title,
  primary,
  secondary,
}: {
  title: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
        {title}
      </p>
      <p className="mt-1 text-2xl font-semibold text-neutral-800">{primary}</p>
      <p className="mt-0.5 text-xs text-neutral-500">{secondary}</p>
    </div>
  );
}

// ---- Feedback section --------------------------------------------------

function FeedbackSection({
  tenantId,
  rows,
  loading,
  error,
  auth,
}: {
  tenantId: string;
  rows: FeedbackRow[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string; tenantId: string };
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
        tenantId: auth.tenantId,
        feedbackId: promoting!.id,
        body: promoteBody,
        kind: promoteKind,
      }),
    onSuccess: () => {
      setPromoting(null);
      setPromoteBody('');
      setPromoteKind('preference');
      setPromoteError(null);
      qc.invalidateQueries({ queryKey: ['learning', tenantId, 'memories'] });
      qc.invalidateQueries({ queryKey: ['learning', tenantId, 'summary'] });
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
    <Card title="Feedback stream" description="Latest 👍 / 👎 from this tenant's chat users.">
      {error ? (
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
        <div className="divide-y divide-neutral-200">
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
      <div className="text-lg leading-none">
        {row.rating === 'up' ? '👍' : '👎'}
      </div>
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
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">{row.reason}</p>
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
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-lg">
        <h3 className="text-base font-semibold text-neutral-800">Promote feedback to memory</h3>
        <p className="mt-1 text-xs text-neutral-500">
          The text you write below is what will be injected into every chat turn for this tenant.
          Rewrite the user&apos;s raw reason into one safe sentence. Keep it under 280 characters.
        </p>
        <div className="mt-3 rounded-md bg-neutral-50 p-2 text-xs text-neutral-600">
          <span className="font-medium">User said:</span> {row.reason}
        </div>
        <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
          Memory body
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={280}
          placeholder="e.g. We call wellhead pressure 'WHP' on Asset-A."
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm focus:border-primary-500 focus:outline-none"
        />
        <div className="mt-1 text-right text-[10px] text-neutral-400">{body.length} / 280</div>
        <label className="mt-2 block text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
          Kind
        </label>
        <select
          aria-label="Memory kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
        >
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {error ? (
          <p className="mt-2 text-xs text-danger-fg">{error}</p>
        ) : null}
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
  tenantId,
  rows,
  loading,
  error,
  auth,
}: {
  tenantId: string;
  rows: MemoryRow[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string; tenantId: string };
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
        tenantId: auth.tenantId,
        body: newBody,
        kind: newKind,
      }),
    onSuccess: () => {
      setNewBody('');
      setNewKind('preference');
      setCreateError(null);
      qc.invalidateQueries({ queryKey: ['learning', tenantId, 'memories'] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) =>
      updateMemory({
        baseUrl: auth.baseUrl,
        token: auth.token,
        tenantId: auth.tenantId,
        memoryId: id,
        status: 'archived',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning', tenantId, 'memories'] }),
  });

  return (
    <Card
      title="Active memories"
      description="One-line preferences injected into every chat turn. Subordinate to base safety rules."
    >
      {error ? (
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
        <ul className="divide-y divide-neutral-200">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 py-3">
              <Badge tone="neutral">{row.kind}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-800">{row.body}</p>
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
      <div className="mt-4 border-t border-neutral-200 pt-4">
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
              className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-primary-500 focus:outline-none"
            />
          </div>
          <select
            aria-label="New memory kind"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as MemoryKind)}
            className="rounded-md border border-neutral-300 px-2 py-2 text-sm"
          >
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
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
        {createError ? (
          <p className="mt-2 text-xs text-danger-fg">{createError}</p>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Glossary section --------------------------------------------------

function GlossarySection({
  tenantId,
  candidates,
  loading,
  error,
  auth,
}: {
  tenantId: string;
  candidates: GlossaryCandidate[];
  loading: boolean;
  error: unknown;
  auth: { baseUrl: string; token: string; tenantId: string };
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
        tenantId: auth.tenantId,
        body,
        kind: 'terminology',
      }),
    onSuccess: () => {
      setApproving(null);
      setBody('');
      setApproveError(null);
      qc.invalidateQueries({ queryKey: ['learning', tenantId, 'memories'] });
      qc.invalidateQueries({ queryKey: ['learning', tenantId, 'glossary'] });
    },
    onError: (err) => setApproveError((err as Error).message),
  });

  function startApprove(c: GlossaryCandidate) {
    setApproving(c);
    // Pre-fill with a sentence rather than the bare term so the body is a
    // memory the model can use, not an orphan token. The admin tweaks before
    // saving.
    setBody(`We use the term "${c.term}" on this asset.`);
    setApproveError(null);
  }

  return (
    <Card
      title="Glossary candidates"
      description="Terms that recur across this tenant's memories. Approving one creates a terminology memory in a single click."
    >
      {error ? (
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
        <ul className="divide-y divide-neutral-200">
          {candidates.map((c) => (
            <li key={c.term} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-medium text-neutral-800">{c.term}</p>
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
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-lg">
        <h3 className="text-base font-semibold text-neutral-800">Approve glossary entry</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Saving creates a <strong>terminology</strong> memory that gets injected into every
          future chat turn for this tenant. Phrase it as a sentence the model can use, not
          just the bare term.
        </p>
        <div className="mt-3 rounded-md bg-neutral-50 p-2 text-xs text-neutral-600">
          <span className="font-medium">Recurring term:</span> <span className="font-mono">{candidate.term}</span>
          {' · seen in '}
          {candidate.count}{' '}{candidate.count === 1 ? 'memory' : 'memories'}
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
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm focus:border-primary-500 focus:outline-none"
        />
        <div className="mt-1 text-right text-[10px] text-neutral-400">{body.length} / 280</div>
        {error ? (
          <p className="mt-2 text-xs text-danger-fg">{error}</p>
        ) : null}
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

// ---- Chunk weights section --------------------------------------------

// Floor / ceiling constants - kept in sync with chunk_weight_floor /
// chunk_weight_ceiling in app/config.py. If those move, update here. A
// chunk is considered "at the floor" when it's within 1% of the floor value
// (covers floating-point round trip plus clamp).
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
      {error ? (
        <Banner tone="danger" title="Failed to load chunk weights">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No retrieval signal yet. Once users rate chat turns that cite documents,
          the chunks involved show up here with their weight + thumbs counts.
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
              <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-[0.06em] text-neutral-500">
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
                  className={isAtFloor(row.weight) ? 'border-b border-danger-border/40 bg-danger-bg/10' : 'border-b border-neutral-100'}
                >
                  <td className="py-2 pr-3 font-mono text-xs text-neutral-700">
                    {row.chunk_id}
                    {isAtFloor(row.weight) ? (
                      <Badge tone="danger" className="ml-2">at floor</Badge>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <WeightBar weight={row.weight} />
                  </td>
                  <td className="py-2 pr-3 text-neutral-700">{row.up_count}</td>
                  <td className="py-2 pr-3 text-neutral-700">{row.down_count}</td>
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

// ---- Trends section ---------------------------------------------------

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
      {error ? (
        <Banner tone="danger" title="Failed to load trends">
          {(error as Error).message}
        </Banner>
      ) : null}
      {loading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!loading && feedback.length === 0 && memory.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No trend data yet.
        </p>
      ) : null}
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
        aria-label={`Feedback per day for the last 30 days. ${totalUp} thumbs up, ${totalDown} thumbs down.`}
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
                <rect
                  x={x}
                  y={padT + innerH - downHeight}
                  width={barW}
                  height={downHeight}
                  fill="#dc2626"
                  fillOpacity={0.7}
                />
              ) : null}
              {p.up > 0 ? (
                <rect
                  x={x}
                  y={yTop}
                  width={barW}
                  height={upHeight}
                  fill="#16a34a"
                  fillOpacity={0.7}
                />
              ) : null}
            </g>
          );
        })}
        {series.length > 0 ? (
          <>
            <text x={padL} y={h - 4} fontSize="9" fill="#9ca3af">
              {formatDayShort(series[0]?.day ?? '')}
            </text>
            <text x={padL + innerW} y={h - 4} fontSize="9" fill="#9ca3af" textAnchor="end">
              {formatDayShort(series[series.length - 1]?.day ?? '')}
            </text>
          </>
        ) : null}
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
        aria-label={`Memory additions per week for the last 12 weeks. ${totalManual} manual, ${totalPromoted} promoted from feedback.`}
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
                <rect
                  x={x}
                  y={padT + innerH - manualHeight}
                  width={barW}
                  height={manualHeight}
                  fill="#a3a3a3"
                  fillOpacity={0.7}
                />
              ) : null}
              {p.promoted > 0 ? (
                <rect
                  x={x}
                  y={yTop}
                  width={barW}
                  height={promotedHeight}
                  fill="#ea580c"
                  fillOpacity={0.8}
                />
              ) : null}
            </g>
          );
        })}
        {series.length > 0 ? (
          <>
            <text x={padL} y={h - 4} fontSize="9" fill="#9ca3af">
              {formatWeekShort(series[0]?.week_start ?? '')}
            </text>
            <text x={padL + innerW} y={h - 4} fontSize="9" fill="#9ca3af" textAnchor="end">
              {formatWeekShort(series[series.length - 1]?.week_start ?? '')}
            </text>
          </>
        ) : null}
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

function formatDayShort(iso: string): string {
  if (!iso || iso.length < 10) return '';
  // YYYY-MM-DD -> MMM D
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatWeekShort(iso: string): string {
  return formatDayShort(iso);
}

function WeightBar({ weight }: { weight: number }) {
  // Range [0.5, 1.5]. Render a bar centred on 1.0 - left of centre = demoted,
  // right of centre = boosted. Pure visual; the number is the source of truth.
  const clamped = Math.max(0.5, Math.min(1.5, weight));
  const pctFromCenter = ((clamped - 1.0) / 0.5) * 50; // -50% .. +50%
  const isDown = clamped < 1.0;
  // Inline style is intentional here: the bar width is data-driven (computed
  // from the weight, which changes per row), so it can't be a static class.
  const barStyle = isDown
    ? { right: '50%', width: `${Math.abs(pctFromCenter)}%` }
    : { left: '50%', width: `${pctFromCenter}%` };
  return (
    <div
      className="flex items-center gap-2"
      title={`weight ${clamped.toFixed(2)} (${isDown ? 'demoted' : 'boosted'})`}
    >
      <div className="relative h-2 w-24 rounded-full bg-neutral-100">
        <div className="absolute left-1/2 top-0 h-2 w-px bg-neutral-300" />
        <div
          className={isDown ? 'absolute top-0 h-2 rounded-full bg-danger-fg/60' : 'absolute top-0 h-2 rounded-full bg-primary-600/70'}
          style={barStyle}
        />
      </div>
      <span className="font-mono text-xs text-neutral-700">{clamped.toFixed(2)}</span>
    </div>
  );
}
