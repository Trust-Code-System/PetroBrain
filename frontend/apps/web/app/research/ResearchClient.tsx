'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BackLink, Banner, Logo, Select } from '@petrobrain/ui';
import type { AssetNode } from '@petrobrain/types';

import { AuthGate } from '../chat/components/AuthGate';
import { EvidencePanel } from '../chat/components/EvidencePanel';
import { Markdown } from '../chat/components/Markdown';
import { fetchAssets } from '@/lib/chat/assets';
import { ownerKeyOf } from '@/lib/chat/conversations';
import { useProjectsStore } from '@/lib/chat/projects';
import { SessionExpiredError } from '@/lib/chat/streamChat';
import { useChatStore } from '@/lib/chat/store';
import {
  approveResearchPlan,
  createResearchPlan,
  exportResearch,
  getResearch,
  listResearch,
  stopResearch,
  streamResearch,
  type CreateResearchInput,
} from '@/lib/research/api';
import type {
  ResearchDepth,
  ResearchEvent,
  ResearchPlanStep,
  ResearchRun,
  ResearchSource,
} from '@/lib/research/types';

import { ThemedDatePicker } from './ThemedDatePicker';

const ALLOWED_ROLES = new Set(['platform_admin', 'admin', 'engineer', 'hse']);

const REPORT_TYPES = [
  ['technical_research_brief', 'Technical research brief'],
  ['executive_memo', 'Executive memo'],
  ['board_memo', 'Board memo'],
  ['investment_memo', 'Investment memo'],
  ['regulatory_memo', 'Regulatory memo'],
  ['hse_audit_research_pack', 'HSE audit research pack'],
  ['esg_research_pack', 'ESG research pack'],
  ['emissions_research_pack', 'Emissions research pack'],
  ['licensing_round_opportunity_brief', 'Licensing-round opportunity brief'],
  ['basin_brief', 'Basin brief'],
  ['field_brief', 'Field brief'],
  ['block_brief', 'Block brief'],
  ['company_profile', 'Company profile'],
  ['asset_profile', 'Asset profile'],
  ['competitor_analysis', 'Competitor analysis'],
  ['counterparty_due_diligence', 'Counterparty due diligence'],
  ['market_intelligence_report', 'Market intelligence report'],
  ['risk_register', 'Risk register'],
  ['compliance_checklist', 'Compliance checklist'],
  ['tender_intelligence_pack', 'Tender intelligence pack'],
  ['regulatory_change_note', 'Regulatory change note'],
  ['management_briefing', 'Management briefing'],
  ['project_opportunity_report', 'Project opportunity report'],
  ['country_entry_report', 'Country entry report'],
  ['oil_gas_news_digest', 'Oil and gas news digest'],
  ['technology_comparison_report', 'Technology comparison report'],
] as const;

interface Draft {
  query: string;
  reportType: string;
  jurisdiction: string;
  assetContext: string;
  projectId: string;
  depth: ResearchDepth;
  internalDocuments: boolean;
  webSearch: boolean;
  allowedDomains: string;
  maxSteps: number;
  maxSources: number;
  dateFrom: string;
  dateTo: string;
  safetyCritical: boolean;
}

const INITIAL_DRAFT: Draft = {
  query: '',
  reportType: 'technical_research_brief',
  jurisdiction: 'Nigeria',
  assetContext: '',
  projectId: '',
  depth: 'standard',
  internalDocuments: true,
  webSearch: true,
  allowedDomains: '',
  maxSteps: 5,
  maxSources: 12,
  dateFrom: '',
  dateTo: '',
  safetyCritical: false,
};

export function ResearchClient() {
  const token = useChatStore((state) => state.token);
  const principal = useChatStore((state) => state.principal);
  const apiBaseUrl = useChatStore((state) => state.apiBaseUrl);
  const hasHydrated = useChatStore((state) => state.hasHydrated);
  const expireSession = useChatStore((state) => state.expireSession);
  const projects = useProjectsStore((state) => state.projects);
  const projectOrder = useProjectsStore((state) => state.order);

  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [assets, setAssets] = useState<AssetNode[]>([]);
  const [history, setHistory] = useState<ResearchRun[]>([]);
  const [active, setActive] = useState<ResearchRun | null>(null);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);
  const myProjects = useMemo(() => {
    if (!ownerKey) return [];
    return projectOrder
      .map((id) => projects[id])
      .filter(
        (project): project is NonNullable<typeof project> =>
          Boolean(project && project.ownerKey === ownerKey),
      );
  }, [ownerKey, projectOrder, projects]);

  useEffect(() => {
    if (!token || !principal) return;
    const controller = new AbortController();
    void Promise.all([
      fetchAssets({
        baseUrl: apiBaseUrl,
        token,
        rootsOnly: true,
        signal: controller.signal,
      }).catch(() => []),
      listResearch({
        baseUrl: apiBaseUrl,
        token,
        signal: controller.signal,
      }).catch((reason: unknown) => {
        handleSessionError(reason, expireSession);
        return [];
      }),
    ]).then(([assetRows, researchRows]) => {
      setAssets(assetRows);
      setHistory(researchRows);
      setActive((current) => current ?? researchRows[0] ?? null);
    });
    return () => controller.abort();
  }, [apiBaseUrl, expireSession, principal, token]);

  if (!hasHydrated) return <LoadingScreen />;
  if (!token || !principal) return <AuthGate />;
  if (!ALLOWED_ROLES.has(principal.role)) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <Banner tone="warn" title="Research access restricted">
          Research Mode is available to engineers, HSE staff, and administrators.
        </Banner>
      </main>
    );
  }

  const context = { baseUrl: apiBaseUrl, token };

  async function createPlan() {
    if (!draft.query.trim() || busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    try {
      const input: CreateResearchInput = {
        query: draft.query.trim(),
        jurisdiction: draft.jurisdiction.trim() || null,
        asset_context: draft.assetContext || null,
        project_id: draft.projectId || null,
        allowed_domains: draft.allowedDomains
          .split(',')
          .map((domain) => domain.trim())
          .filter(Boolean),
        date_from: draft.dateFrom || null,
        date_to: draft.dateTo || null,
        internal_documents_allowed: draft.internalDocuments,
        web_search_allowed: draft.webSearch,
        connectors_allowed: false,
        maximum_research_steps: draft.maxSteps,
        maximum_sources: draft.maxSources,
        report_type: draft.reportType,
        output_depth: draft.depth,
        citation_required: true,
        safety_critical: draft.safetyCritical,
        export_format: 'markdown',
      };
      const record = await createResearchPlan(context, input);
      setActive(record);
      setHistory((current) => [record, ...current.filter((row) => row.id !== record.id)]);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function approvePlan() {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await approveResearchPlan(context, active.id, active.plan);
      setActive(record);
      replaceHistory(record);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!active || active.status !== 'approved' || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setEvents([]);
    setActive({ ...active, status: 'running' });
    try {
      await streamResearch(
        { ...context, signal: controller.signal },
        active.id,
        (event) => {
          setEvents((current) => [...current, event]);
          if (event.event === 'completed' && isResearchRun(event.data['record'])) {
            const record = event.data['record'];
            setActive(record);
            replaceHistory(record);
          }
          if (event.event === 'failed') {
            setError(String(event.data['message'] ?? 'Research failed.'));
          }
          if (event.event === 'stopped') {
            setActive((current) => (current ? { ...current, status: 'stopped' } : current));
          }
        },
      );
      const refreshed = await getResearch(context, active.id);
      setActive(refreshed);
      replaceHistory(refreshed);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        handleError(reason);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function stop() {
    if (!active) return;
    abortRef.current?.abort();
    try {
      const record = await stopResearch(context, active.id);
      setActive(record);
      replaceHistory(record);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  function updatePlanStep(index: number, patch: Partial<ResearchPlanStep>) {
    setActive((current) => {
      if (!current) return current;
      const plan = current.plan.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step,
      );
      return { ...current, plan };
    });
  }

  function selectHistory(record: ResearchRun) {
    if (busy) return;
    setActive(record);
    setEvents([]);
    setError(null);
  }

  function replaceHistory(record: ResearchRun) {
    setHistory((current) => [
      record,
      ...current.filter((row) => row.id !== record.id),
    ]);
  }

  function handleError(reason: unknown) {
    if (handleSessionError(reason, expireSession)) return;
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  return (
    <main className="min-h-screen bg-neutral-50/70 dark:bg-neutral-950 xl:flex xl:h-screen xl:min-h-0 xl:flex-col xl:overflow-hidden">
      <header className="shrink-0 border-b border-neutral-200/80 bg-white/90 px-5 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/chat" legacyBehavior passHref>
              <BackLink label="Back to chat" />
            </Link>
            <span className="h-5 w-px bg-neutral-200 dark:bg-neutral-800" />
            <Logo size={28} />
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
                PetroBrain Research
              </h1>
              <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">
                Oil and gas analyst workstation
              </p>
            </div>
          </div>
          <StatusPill status={active?.status ?? null} />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 p-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[21rem_minmax(0,1fr)_24rem] xl:overflow-hidden">
        <aside className="space-y-4 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain xl:pr-1">
          <ResearchBrief
            draft={draft}
            setDraft={setDraft}
            assets={assets}
            projects={myProjects}
            busy={busy}
            onCreate={createPlan}
          />
          <HistoryPanel
            history={history}
            {...(active?.id ? { activeId: active.id } : {})}
            onSelect={selectHistory}
          />
        </aside>

        <section className="min-w-0 space-y-4 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain xl:pr-1">
          <Banner tone="brand" title="DECISION SUPPORT ONLY">
            Research reports are evidence-led drafts. Verify safety, legal, regulatory,
            commercial, and investment conclusions with the responsible authority.
          </Banner>

          {error ? (
            <Banner tone="danger" title="Research could not continue">
              {error}
            </Banner>
          ) : null}

          {!active ? <EmptyWorkspace /> : null}

          {active ? (
            <>
              <PlanPanel
                record={active}
                events={events}
                busy={busy}
                onUpdateStep={updatePlanStep}
                onApprove={approvePlan}
                onRun={run}
                onStop={stop}
              />
              {active.report ? (
                <ReportPanel
                  record={active}
                  onExport={(format) =>
                    exportResearch(context, active.id, format).catch(handleError)
                  }
                />
              ) : null}
            </>
          ) : null}
        </section>

        <aside className="space-y-4 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain xl:pr-1">
          <SourcePanel sources={active?.sources ?? []} events={events} />
          {active?.evidence_pack ? (
            <Panel title="Evidence">
              <EvidencePanel evidence={active.evidence_pack} />
            </Panel>
          ) : null}
          {active?.report ? <VerificationPanel record={active} /> : null}
        </aside>
      </div>
    </main>
  );
}

function ResearchBrief({
  draft,
  setDraft,
  assets,
  projects,
  busy,
  onCreate,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  assets: AssetNode[];
  projects: Array<{ id: string; name: string }>;
  busy: boolean;
  onCreate: () => void;
}) {
  return (
    <Panel title="Research brief">
      <div className="space-y-3">
        <Field label="Research question">
          <textarea
            rows={5}
            value={draft.query}
            onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder="Research an operator, field, basin, regulation, project, market, counterparty, or technical trend."
            className={inputClass}
          />
        </Field>
        <Select
          label="Report type"
          value={draft.reportType}
          onChange={(event) =>
            setDraft((current) => ({ ...current, reportType: event.target.value }))
          }
          options={REPORT_TYPES.map(([value, label]) => ({ value, label }))}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Jurisdiction">
            <input
              value={draft.jurisdiction}
              onChange={(event) => setDraft((current) => ({ ...current, jurisdiction: event.target.value }))}
              className={inputClass}
            />
          </Field>
          <Select
            label="Depth"
            value={draft.depth}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                depth: event.target.value as ResearchDepth,
              }))
            }
            options={[
              { value: 'quick', label: 'Quick brief' },
              { value: 'standard', label: 'Standard report' },
              { value: 'deep', label: 'Deep research' },
            ]}
          />
        </div>
        <Select
          label="Asset"
          value={draft.assetContext}
          onChange={(event) =>
            setDraft((current) => ({ ...current, assetContext: event.target.value }))
          }
          options={[
            { value: '', label: 'Tenant-wide' },
            ...assets.map((asset) => ({ value: asset.id, label: asset.name })),
          ]}
        />
        <Select
          label="Project"
          value={draft.projectId}
          onChange={(event) =>
            setDraft((current) => ({ ...current, projectId: event.target.value }))
          }
          options={[
            { value: '', label: 'No project' },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <ThemedDatePicker
            label="From date"
            value={draft.dateFrom}
            onChange={(value) =>
              setDraft((current) => ({ ...current, dateFrom: value }))
            }
          />
          <ThemedDatePicker
            label="To date"
            value={draft.dateTo}
            align="right"
            onChange={(value) =>
              setDraft((current) => ({ ...current, dateTo: value }))
            }
          />
        </div>
        <Field label="Approved domains">
          <input
            value={draft.allowedDomains}
            onChange={(event) => setDraft((current) => ({ ...current, allowedDomains: event.target.value }))}
            placeholder="nuprc.gov.ng, opec.org"
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Max steps"
            value={draft.maxSteps}
            min={1}
            max={8}
            onChange={(value) => setDraft((current) => ({ ...current, maxSteps: value }))}
          />
          <NumberField
            label="Max sources"
            value={draft.maxSources}
            min={1}
            max={20}
            onChange={(value) => setDraft((current) => ({ ...current, maxSources: value }))}
          />
        </div>
        <SourceToggle
          label="Internal tenant documents"
          checked={draft.internalDocuments}
          onChange={(checked) => setDraft((current) => ({ ...current, internalDocuments: checked }))}
        />
        <SourceToggle
          label="Governed public web"
          checked={draft.webSearch}
          onChange={(checked) => setDraft((current) => ({ ...current, webSearch: checked }))}
        />
        <SourceToggle label="Approved connectors (not enabled)" checked={false} disabled onChange={() => {}} />
        <SourceToggle
          label="Safety-critical subject"
          checked={draft.safetyCritical}
          onChange={(checked) => setDraft((current) => ({ ...current, safetyCritical: checked }))}
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={busy || !draft.query.trim() || (!draft.internalDocuments && !draft.webSearch)}
          className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-primary-600 px-4 text-sm font-semibold text-white shadow-brand-primary transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Preparing...' : 'Create research plan'}
        </button>
      </div>
    </Panel>
  );
}

function PlanPanel({
  record,
  events,
  busy,
  onUpdateStep,
  onApprove,
  onRun,
  onStop,
}: {
  record: ResearchRun;
  events: ResearchEvent[];
  busy: boolean;
  onUpdateStep: (index: number, patch: Partial<ResearchPlanStep>) => void;
  onApprove: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const editable = record.status === 'plan_ready';
  return (
    <Panel title="Research plan" trailing={<StatusPill status={record.status} />}>
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Question</p>
        <h2 className="mt-1 text-lg font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
          {record.query}
        </h2>
      </div>
      <ol className="space-y-2">
        {record.plan.map((step, index) => (
          <li
            key={step.id}
            className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-xl border border-neutral-200/80 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-950/50"
          >
            <StepState status={step.status} index={index + 1} />
            <div className="min-w-0 space-y-1.5">
              {editable ? (
                <>
                  <input
                    value={step.title}
                    onChange={(event) => onUpdateStep(index, { title: event.target.value })}
                    className={`${inputClass} font-semibold`}
                  />
                  <textarea
                    rows={2}
                    value={step.question}
                    onChange={(event) => onUpdateStep(index, { question: event.target.value })}
                    className={inputClass}
                  />
                </>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{step.title}</h3>
                  <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{step.question}</p>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <EventSummary events={events} />
        <div className="flex items-center gap-2">
          {record.status === 'plan_ready' ? (
            <button type="button" onClick={onApprove} disabled={busy} className={secondaryButton}>
              Approve plan
            </button>
          ) : null}
          {record.status === 'approved' ? (
            <button type="button" onClick={onRun} disabled={busy} className={primaryButton}>
              Run research
            </button>
          ) : null}
          {record.status === 'running' ? (
            <button type="button" onClick={onStop} className={dangerButton}>
              Stop research
            </button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ReportPanel({
  record,
  onExport,
}: {
  record: ResearchRun;
  onExport: (format: 'markdown' | 'text') => void;
}) {
  return (
    <Panel
      title="Final report"
      trailing={
        <div className="flex gap-1.5">
          <button type="button" onClick={() => onExport('markdown')} className={smallButton}>Markdown</button>
          <button type="button" onClick={() => onExport('text')} className={smallButton}>Text</button>
        </div>
      }
    >
      <div className="prose-pb max-w-none">
        <Markdown>{record.report?.markdown ?? ''}</Markdown>
      </div>
    </Panel>
  );
}

function SourcePanel({ sources, events }: { sources: ResearchSource[]; events: ResearchEvent[] }) {
  const pendingSources = events.filter((event) => event.event === 'source_found');
  return (
    <Panel title="Source ledger" trailing={<span className="text-xs text-neutral-500">{sources.length}</span>}>
      {sources.length === 0 && pendingSources.length === 0 ? (
        <p className="text-sm text-neutral-500">Sources appear here as the plan runs.</p>
      ) : null}
      <div className="space-y-2">
        {sources.map((source) => (
          <article key={source.id} className="rounded-xl border border-neutral-200/80 p-3 dark:border-neutral-800">
            <div className="flex items-start justify-between gap-2">
              <span className="rounded-md bg-primary-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">
                {source.id}
              </span>
              <div className="flex gap-1">
                <MiniBadge>{source.reliability}</MiniBadge>
                <MiniBadge>{source.freshness}</MiniBadge>
              </div>
            </div>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm font-semibold text-primary-700 hover:underline dark:text-primary-300">
                {source.title}
              </a>
            ) : (
              <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{source.title}</h3>
            )}
            <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {source.snippet}
            </p>
            {source.document_id ? (
              <p className="mt-2 font-mono text-[10px] text-neutral-500">
                {source.document_id}{source.revision ? ` / ${source.revision}` : ''}{source.clause ? ` / ${source.clause}` : ''}
              </p>
            ) : null}
          </article>
        ))}
        {sources.length === 0
          ? pendingSources.map((event, index) => (
              <div key={`${String(event.data['title'])}-${index}`} className="rounded-xl border border-dashed border-neutral-300 p-3 text-xs text-neutral-500 dark:border-neutral-700">
                Found {String(event.data['title'] ?? 'source')}
              </div>
            ))
          : null}
      </div>
    </Panel>
  );
}

function VerificationPanel({ record }: { record: ResearchRun }) {
  const report = record.report!;
  return (
    <Panel title="Verification">
      <Metric label="Confidence" value={report.confidence.label} detail={report.confidence.reason} />
      <ListSection title="What was checked" items={report.checked} />
      <ListSection title="Could not verify" items={report.not_verified} />
      <ListSection title="Contradictions" items={report.contradictions} empty="No potential contradiction was detected automatically." />
      <ListSection title="Warnings" items={report.warnings} />
    </Panel>
  );
}

function HistoryPanel({
  history,
  activeId,
  onSelect,
}: {
  history: ResearchRun[];
  activeId?: string;
  onSelect: (record: ResearchRun) => void;
}) {
  return (
    <Panel title="Research history">
      {history.length === 0 ? <p className="text-sm text-neutral-500">No research runs yet.</p> : null}
      <div className="space-y-1">
        {history.map((record) => (
          <button
            key={record.id}
            type="button"
            onClick={() => onSelect(record)}
            className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
              activeId === record.id
                ? 'bg-primary-50 dark:bg-primary-900/30'
                : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'
            }`}
          >
            <p className="line-clamp-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200">{record.query}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[10px] text-neutral-500">{new Date(record.updated_utc).toLocaleDateString()}</span>
              <StatusPill status={record.status} compact />
            </div>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function EventSummary({ events }: { events: ResearchEvent[] }) {
  const latest = events.at(-1);
  if (!latest) return <span className="text-xs text-neutral-500">Review and approve the plan before execution.</span>;
  const labels: Record<ResearchEvent['event'], string> = {
    started: 'Research started',
    step_started: `Working: ${String(latest.data['title'] ?? '')}`,
    source_found: `Source found: ${String(latest.data['title'] ?? '')}`,
    warning: String(latest.data['message'] ?? 'Source warning'),
    step_completed: 'Research step completed',
    synthesizing: 'Synthesizing governed report',
    completed: 'Research completed',
    failed: 'Research failed',
    stopped: 'Research stopped',
  };
  return (
    <span aria-live="polite" className="inline-flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
      <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-pulse" />
      {labels[latest.event]}
    </span>
  );
}

function EmptyWorkspace() {
  return (
    <Panel title="Start a governed research run">
      <div className="grid min-h-64 place-items-center text-center">
        <div className="max-w-md">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-300">
            <ResearchIcon />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Build an evidence-led oil and gas brief
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Define the question, jurisdiction, asset, source boundaries, and report type.
            PetroBrain will propose a plan for approval before collecting evidence.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function Panel({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-brand-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-600 dark:text-neutral-300">{title}</h2>
        {trailing}
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className={inputClass}
      />
    </Field>
  );
}

function SourceToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-800 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
      />
    </label>
  );
}

function StepState({ status, index }: { status: ResearchPlanStep['status']; index: number }) {
  const complete = status === 'completed';
  const running = status === 'running';
  return (
    <span
      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${
        complete
          ? 'bg-success-bg text-success-fg'
          : running
            ? 'bg-primary-100 text-primary-700 ring-2 ring-primary-300 dark:bg-primary-900/40 dark:text-primary-300'
            : 'bg-white text-neutral-500 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700'
      }`}
    >
      {complete ? '\u2713' : index}
    </span>
  );
}

function StatusPill({
  status,
  compact,
}: {
  status: ResearchRun['status'] | null;
  compact?: boolean;
}) {
  if (!status) return null;
  const tone =
    status === 'completed'
      ? 'bg-success-bg text-success-fg'
      : status === 'failed' || status === 'rejected'
        ? 'bg-danger-bg text-danger-fg'
        : status === 'running'
          ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300';
  return (
    <span className={`inline-flex items-center rounded-full font-semibold uppercase tracking-[0.1em] ${tone} ${compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2.5 py-1 text-[9px]'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function MiniBadge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-950/50">
      <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">{detail}</p>
    </div>
  );
}

function ListSection({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty?: string;
}) {
  if (items.length === 0 && !empty) return null;
  return (
    <div className="mt-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">{title}</h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
        {items.length > 0
          ? items.map((item) => <li key={item}>{item}</li>)
          : <li>{empty}</li>}
      </ul>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center">
      <span className="h-10 w-10 rounded-full border-2 border-primary-200 border-t-primary-600 animate-spin" />
    </main>
  );
}

function ResearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 12l4 4M6.5 8.5h4M8.5 6.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function handleSessionError(
  reason: unknown,
  expireSession: (kind: 'expired' | 'revoked' | 'invalid') => void,
): boolean {
  if (!(reason instanceof SessionExpiredError)) return false;
  expireSession(reason.reason);
  return true;
}

function isResearchRun(value: unknown): value is ResearchRun {
  return typeof value === 'object' && value !== null && typeof (value as ResearchRun).id === 'string';
}

const inputClass =
  'w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 hover:border-primary-300 focus:border-primary-400 focus:ring-2 focus:ring-primary-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:border-primary-600 dark:focus:ring-primary-900/40';
const primaryButton =
  'inline-flex h-9 items-center rounded-full bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50';
const secondaryButton =
  'inline-flex h-9 items-center rounded-full border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 hover:border-primary-300 hover:text-primary-700 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
const dangerButton =
  'inline-flex h-9 items-center rounded-full border border-danger-fg/30 bg-danger-bg px-4 text-sm font-semibold text-danger-fg';
const smallButton =
  'inline-flex h-7 items-center rounded-full border border-neutral-200 px-2.5 text-[10px] font-semibold text-neutral-600 hover:border-primary-300 hover:text-primary-700 dark:border-neutral-700 dark:text-neutral-300';
