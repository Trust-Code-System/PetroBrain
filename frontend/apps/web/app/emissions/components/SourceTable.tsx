'use client';

import clsx from 'clsx';

import { Badge } from '@petrobrain/ui';

import type { InventoryLine } from '@/lib/emissions/types';

export interface SourceTableProps {
  lines: InventoryLine[];
}

/**
 * Per-source emissions table.
 *
 * Row tone tracks tier readiness - Tier 3 (measurement-based) is "ok",
 * Tier 2 (factor-based) is "warn" because it must move to Tier 3 before
 * the Jan-2027 deadline, Tier 1 is "danger".
 *
 * Per-line CO₂e is not in the response (the engine applies GWP only at
 * the totals level); we surface the raw gas tonnes here and let the KPI
 * strip carry CO₂e.
 */
export function SourceTable({ lines }: SourceTableProps) {
  if (lines.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400">
        No sources in this inventory.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">Source</th>
            <th scope="col" className="px-3 py-2 text-left">Type</th>
            <th scope="col" className="px-3 py-2 text-left">Tier</th>
            <th scope="col" className="px-3 py-2 text-left">Method</th>
            <th scope="col" className="px-3 py-2 text-right">CH₄ (t)</th>
            <th scope="col" className="px-3 py-2 text-right">CO₂ (t)</th>
            <th scope="col" className="px-3 py-2 text-right">N₂O (t)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-900/60">
          {lines.map((line) => (
            <tr
              key={line.source_id}
              data-testid={`source-${line.source_id}`}
              className={clsx(rowToneClass(line.tier))}
            >
              <td className="px-3 py-2 font-mono text-xs text-neutral-800 dark:text-neutral-200">{line.source_id}</td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{line.source_type}</td>
              <td className="px-3 py-2">
                <Badge tone={tierBadgeTone(line.tier)}>{line.tier}</Badge>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{line.method}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-800 dark:text-neutral-200">
                {fmt(line.ch4_tonnes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-800 dark:text-neutral-200">
                {fmt(line.co2_tonnes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-800 dark:text-neutral-200">
                {fmt(line.n2o_tonnes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowToneClass(tier: string): string {
  if (tier === 'Tier 3') return 'bg-safe-bg/40 dark:bg-safe-fg/20';
  if (tier === 'Tier 2') return 'bg-warn-bg/40 dark:bg-warn-fg/20';
  if (tier === 'Tier 1') return 'bg-danger-bg/40 dark:bg-danger-fg/20';
  return '';
}

export function tierBadgeTone(tier: string): 'safe' | 'warn' | 'danger' | 'neutral' {
  if (tier === 'Tier 3') return 'safe';
  if (tier === 'Tier 2') return 'warn';
  if (tier === 'Tier 1') return 'danger';
  return 'neutral';
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
