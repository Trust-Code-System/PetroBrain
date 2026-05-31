'use client';

import clsx from 'clsx';

import { Badge } from '@petrobrain/ui';

import type { InventoryHistoryRow } from '@/lib/emissions/types';

export interface InventoryHistoryProps {
  rows: InventoryHistoryRow[];
  selectedId: string | null;
  onSelect: (inventoryId: string) => void;
  isLoading: boolean;
  isError: boolean;
}

export function InventoryHistory({ rows, selectedId, onSelect, isLoading, isError }: InventoryHistoryProps) {
  if (isError) {
    return (
      <p role="alert" className="rounded-md border border-danger-border bg-danger-bg p-3 text-sm text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
        Could not load inventories. Check your sign-in and the API base URL.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400">
        {isLoading ? 'Loading inventories…' : 'No inventories match the current filter.'}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400">
          <tr>
            <th className="px-3 py-2 text-left">Facility</th>
            <th className="px-3 py-2 text-left">Period</th>
            <th className="px-3 py-2 text-left">Operator</th>
            <th className="px-3 py-2 text-left">Asset</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-right">CO₂e (t)</th>
            <th className="px-3 py-2 text-right">Tier %</th>
            <th className="px-3 py-2 text-right">Gaps</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-900/60">
          {rows.map((row) => (
            <tr
              key={row.inventory_id}
              data-testid={`history-${row.inventory_id}`}
              onClick={() => onSelect(row.inventory_id)}
              className={clsx(
                'cursor-pointer transition-colors hover:bg-primary-50 dark:hover:bg-primary-900/30',
                row.inventory_id === selectedId && 'bg-primary-50 dark:bg-primary-900/40',
              )}
            >
              <td className="px-3 py-2 font-mono text-xs text-neutral-800 dark:text-neutral-200">{row.facility_id}</td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{row.period}</td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{row.operator}</td>
              <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">{row.asset ?? '-'}</td>
              <td className="px-3 py-2">
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-800 dark:text-neutral-200">
                {fmt(row.total_co2e_tonnes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-800 dark:text-neutral-200">
                {fmt(row.tier_readiness_pct, 1)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-700 dark:text-neutral-300">
                {row.gap_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusTone(status: string): 'safe' | 'warn' | 'danger' | 'neutral' {
  if (status === 'ready_for_target_tier') return 'safe';
  if (status === 'partial_tier_coverage') return 'warn';
  if (status === 'requires_remediation') return 'danger';
  return 'neutral';
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}
