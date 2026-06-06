'use client';

import { useState } from 'react';
import clsx from 'clsx';

export interface WorkingPanelProps {
  tool: string;
  input: unknown;
  result: unknown;
  defaultOpen?: boolean;
}

export function WorkingPanel({ tool, result, defaultOpen = false }: WorkingPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (tool === 'create_task' && isObject(result)) {
    return <TaskCard task={result} />;
  }

  if (tool === 'web_search') {
    const count = isObject(result) && Array.isArray(result['results'])
      ? result['results'].length
      : null;
    return (
      <div className="inline-flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          Checked current sources
        </span>
        {count !== null ? (
          <span className="text-neutral-400 dark:text-neutral-500">
            - {count} result{count === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group"
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs">
        <svg
          width="10"
          height="10"
          viewBox="0 0 20 20"
          fill="none"
          className="text-neutral-400 transition-transform [details[open]_&]:rotate-90 dark:text-neutral-500"
        >
          <path
            d="M7 5l6 5-6 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {userSafeToolLabel(tool)}
        </span>
      </summary>
      <div className="mt-2 space-y-3">
        <HeadlineNumbers result={result} />
        <Steps result={result} />
      </div>
    </details>
  );
}

function TaskCard({ task }: { task: Record<string, unknown> }) {
  const rows = [
    ['Assigned team', task['assigned_to_team']],
    ['Recurrence', task['recurrence_type']],
    ['Next due', formatDate(task['next_run_at'] ?? task['due_date'])],
    ['Category', task['category']],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  return (
    <section className="rounded-xl border border-primary-200 bg-primary-50/60 p-3.5 dark:border-primary-800 dark:bg-primary-950/25">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-700 dark:text-primary-300">
            PetroBrain task
          </p>
          <h4 className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {String(task['title'] ?? 'Compliance task')}
          </h4>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold uppercase text-primary-700 shadow-sm dark:bg-neutral-900 dark:text-primary-300">
          {String(task['status'] ?? 'active')}
        </span>
      </div>
      {rows.length > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
              <dd className="font-medium capitalize text-neutral-800 dark:text-neutral-200">
                {value.replace(/_/g, ' ')}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-3 text-[11px] text-neutral-500 dark:text-neutral-400">
        Saved in PetroBrain. External email and calendar delivery is not enabled.
      </p>
      <a href="/tasks" className="mt-3 inline-flex text-xs font-semibold text-primary-700 hover:underline dark:text-primary-300">
        View task
      </a>
    </section>
  );
}

function formatDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function HeadlineNumbers({ result }: { result: unknown }) {
  if (!isObject(result)) return null;
  const entries = Object.entries(result).filter(
    ([k, v]) =>
      k !== 'banner' &&
      k !== 'working' &&
      k !== 'notes' &&
      (typeof v === 'number' || typeof v === 'string'),
  );
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {humanizeKey(k)}
          </dt>
          <dd className="font-semibold text-neutral-800 dark:text-neutral-100">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Steps({ result }: { result: unknown }) {
  if (!isObject(result)) return null;
  const working = result['working'];
  if (!Array.isArray(working) || working.length === 0) return null;
  return (
    <ol className={clsx('list-decimal space-y-1 pl-5 text-xs text-neutral-700 dark:text-neutral-300')}>
      {working.map((step, i) => (
        <li key={i}>
          {typeof step === 'string' ? step : JSON.stringify(step)}
        </li>
      ))}
    </ol>
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function userSafeToolLabel(tool: string): string {
  const labels: Record<string, string> = {
    web_search: 'Checked current sources',
    build_kill_sheet: 'Built kill sheet',
    build_ptw_template: 'Built permit template',
    build_ghgemp_report: 'Built GHGEMP report',
    build_report: 'Built report',
    flaring_emissions: 'Calculated flaring emissions',
    venting_emissions: 'Calculated venting emissions',
    fugitive_tier2: 'Estimated fugitive emissions',
    fugitive_tier3: 'Estimated fugitive emissions',
    combustion_emissions: 'Calculated combustion emissions',
    reconcile_flaring: 'Reconciled flaring data',
    model_abatement: 'Modeled abatement options',
    create_task: 'Created PetroBrain task',
    query_audit: 'Retrieved audit trail',
  };
  return labels[tool] ?? 'Checked supporting information';
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bPpg\b/g, 'ppg')
    .replace(/\bPsi\b/g, 'psi');
}
