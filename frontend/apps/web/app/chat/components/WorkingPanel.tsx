'use client';

import { useState } from 'react';
import clsx from 'clsx';

export interface WorkingPanelProps {
  tool: string;
  input: unknown;
  result: unknown;
  defaultOpen?: boolean;
}

/**
 * Collapsible per-tool detail. Renders, in order: a row of headline numbers
 * from the result (everything that's not an array / object / banner), then
 * the working steps array, then the raw input + result as JSON for
 * engineers who want to audit a specific line.
 *
 * Stays expanded by default for safety-critical tools (kill_sheet,
 * MAASP …) so the working is not hidden behind a click.
 */
export function WorkingPanel({ tool, input, result, defaultOpen = false }: WorkingPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Web search is an information-retrieval tool; the sources footer already
  // shows the citation set, so the working trace just needs a one-line
  // confirmation that the search ran with the model's query. No headline
  // numbers, no raw JSON dump - that's noise for the user, the audit log
  // keeps the full payload for engineering.
  if (tool === 'web_search') {
    const query = isObject(input) && typeof input['query'] === 'string'
      ? input['query']
      : null;
    const count = isObject(result) && Array.isArray(result['results'])
      ? result['results'].length
      : null;
    return (
      <div className="inline-flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          web_search
        </code>
        {query ? (
          <span className="truncate" title={query}>
            <span className="text-neutral-400 dark:text-neutral-500">query:</span>{' '}
            <span className="text-neutral-700 dark:text-neutral-300">{query}</span>
          </span>
        ) : null}
        {count !== null ? (
          <span className="text-neutral-400 dark:text-neutral-500">
            · {count} result{count === 1 ? '' : 's'}
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
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {tool}
        </code>
      </summary>
      <div className="mt-2 space-y-3">
        <HeadlineNumbers result={result} />
        <Steps result={result} />
        <RawBlocks tool={tool} input={input} result={result} />
      </div>
    </details>
  );
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
          <dt className="font-mono text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{k}</dt>
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
        <li key={i} className="font-mono">
          {typeof step === 'string' ? step : JSON.stringify(step)}
        </li>
      ))}
    </ol>
  );
}

function RawBlocks({ tool, input, result }: { tool: string; input: unknown; result: unknown }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <RawBlock label={`${tool} input`} value={input} />
      <RawBlock label={`${tool} result`} value={result} />
    </div>
  );
}

function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-md border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
      <summary className="cursor-pointer px-2 py-1 text-xs text-neutral-600 dark:text-neutral-400">{label}</summary>
      <pre className="overflow-x-auto px-2 pb-2 text-[11px] text-neutral-700 dark:text-neutral-300">
        {value === undefined ? '(none)' : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
