'use client';

import { useMemo } from 'react';

import { Input, Select } from '@petrobrain/ui';

import { parsePeriod } from '@/lib/emissions/period';
import type { InventoryHistoryRow } from '@/lib/emissions/types';

export interface HistoryFilterState {
  facility: string;
  year: number | 'all';
  quarter: 1 | 2 | 3 | 4 | 'all';
}

export interface HistoryFiltersProps {
  rows: InventoryHistoryRow[];
  value: HistoryFilterState;
  onChange: (next: HistoryFilterState) => void;
}

export function HistoryFilters({ rows, value, onChange }: HistoryFiltersProps) {
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const row of rows) {
      const parsed = parsePeriod(row.period);
      if (parsed) set.add(parsed.year);
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [rows]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Input
        label="Facility"
        placeholder="e.g. FAC-1"
        value={value.facility}
        onChange={(e) => onChange({ ...value, facility: e.target.value })}
      />
      <Select
        label="Year"
        value={String(value.year)}
        onChange={(e) =>
          onChange({
            ...value,
            year: e.target.value === 'all' ? 'all' : Number(e.target.value),
          })
        }
        options={[
          { value: 'all', label: 'All years' },
          ...years.map((y) => ({ value: String(y), label: String(y) })),
        ]}
      />
      <Select
        label="Quarter"
        value={String(value.quarter)}
        onChange={(e) =>
          onChange({
            ...value,
            quarter: e.target.value === 'all'
              ? 'all'
              : (Number(e.target.value) as 1 | 2 | 3 | 4),
          })
        }
        options={[
          { value: 'all', label: 'All quarters' },
          { value: '1', label: 'Q1' },
          { value: '2', label: 'Q2' },
          { value: '3', label: 'Q3' },
          { value: '4', label: 'Q4' },
        ]}
      />
    </div>
  );
}

/**
 * Pure filter reducer - exported so the test can drive it directly.
 *
 * Rows whose period doesn't parse as ``YYYY-Q[1-4]`` pass through when
 * the year or quarter filter is "all" but are dropped once the user
 * commits to a specific period. The intent: don't hide unstructured
 * legacy data, but don't pretend it matches a real quarter either.
 */
export function applyHistoryFilters(
  rows: InventoryHistoryRow[],
  filters: HistoryFilterState,
): InventoryHistoryRow[] {
  const facility = filters.facility.trim().toLowerCase();
  return rows.filter((row) => {
    if (facility && !row.facility_id.toLowerCase().includes(facility)) return false;
    if (filters.year === 'all' && filters.quarter === 'all') return true;
    const parsed = parsePeriod(row.period);
    if (!parsed) return false;
    if (filters.year !== 'all' && parsed.year !== filters.year) return false;
    if (filters.quarter !== 'all' && parsed.quarter !== filters.quarter) return false;
    return true;
  });
}
