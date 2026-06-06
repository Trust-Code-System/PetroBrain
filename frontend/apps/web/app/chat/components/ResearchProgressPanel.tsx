'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

import type { ProgressSource, WorkingStep } from '@/lib/chat/types';

interface ResearchProgressPanelProps {
  steps: WorkingStep[];
  sources: ProgressSource[];
  streaming: boolean;
}

export function ResearchProgressPanel({
  steps,
  sources,
  streaming,
}: ResearchProgressPanelProps) {
  const [expanded, setExpanded] = useState(streaming);
  const completed = steps.filter((step) => step.status === 'completed').length;
  const active = [...steps].reverse().find((step) => step.status === 'running');
  const failed = steps.find((step) => step.status === 'failed');
  const summary = streaming
    ? active?.label ?? 'Working on your response...'
    : failed
      ? failed.label
      : `Completed ${completed} checks`;

  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);

  return (
    <section
      aria-label="Research progress"
      className="overflow-hidden rounded-xl border border-primary-200/70 bg-gradient-to-br from-white to-primary-50/50 shadow-[0_8px_30px_rgba(124,45,18,0.06)] dark:border-primary-800/50 dark:from-neutral-900 dark:to-primary-950/20"
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ProgressGlyph status={failed ? 'failed' : streaming ? 'running' : 'completed'} />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400">
            {streaming ? 'Working' : 'Research progress'}
          </span>
          <span className="block truncate text-sm font-medium text-neutral-800 dark:text-neutral-100" aria-live="polite">
            {summary}
          </span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden
          className={clsx(
            'shrink-0 text-neutral-400 transition-transform',
            expanded && 'rotate-180',
          )}
        >
          <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded ? (
        <div className="border-t border-primary-100/80 px-3.5 py-3 dark:border-primary-900/50">
          <ol className="space-y-2" aria-label="Working steps">
            {steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2.5">
                <ProgressGlyph status={step.status} compact />
                <span
                  className={clsx(
                    'pt-px text-xs leading-5',
                    step.status === 'running' && 'font-medium text-neutral-900 dark:text-neutral-100',
                    step.status === 'completed' && 'text-neutral-600 dark:text-neutral-300',
                    step.status === 'pending' && 'text-neutral-400 dark:text-neutral-600',
                    step.status === 'failed' && 'font-medium text-red-700 dark:text-red-300',
                  )}
                >
                  {step.label}
                </span>
              </li>
            ))}
          </ol>

          {sources.length > 0 ? (
            <div className="mt-3 border-t border-neutral-200/70 pt-2.5 dark:border-neutral-800">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">
                Sources discovered
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sources.slice(0, 6).map((source, index) => (
                  <span
                    key={`${source.url ?? source.title}-${index}`}
                    title={source.title}
                    className="max-w-[13rem] truncate rounded-full border border-neutral-200 bg-white px-2 py-1 text-[10px] font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                  >
                    {source.domain || source.title}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ProgressGlyph({
  status,
  compact = false,
}: {
  status: WorkingStep['status'];
  compact?: boolean;
}) {
  const size = compact ? 'h-4 w-4' : 'h-7 w-7';
  if (status === 'running') {
    return (
      <span
        aria-label="Running"
        className={clsx(
          'relative flex shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-600 dark:bg-primary-900/50 dark:text-primary-300',
          size,
        )}
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-primary-400/25" />
        <span className={clsx('rounded-full bg-current', compact ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span
        aria-label="Completed"
        className={clsx(
          'flex shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
          size,
        )}
      >
        <svg width={compact ? 10 : 14} height={compact ? 10 : 14} viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M4.5 10.5l3.3 3.3 7.7-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        aria-label="Failed"
        className={clsx(
          'flex shrink-0 items-center justify-center rounded-full bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
          size,
        )}
      >
        !
      </span>
    );
  }
  return (
    <span
      aria-label="Pending"
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-full border border-neutral-300 dark:border-neutral-700',
        size,
      )}
    />
  );
}
