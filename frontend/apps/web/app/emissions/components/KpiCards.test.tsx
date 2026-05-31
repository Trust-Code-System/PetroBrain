import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { InventoryResponse } from '@/lib/emissions/types';

import { KpiCards } from './KpiCards';

function fixture(overrides: Partial<InventoryResponse> = {}): InventoryResponse {
  const base: InventoryResponse = {
    inventory: {
      facility_id: 'FAC-1',
      period: '2026-Q3',
      totals: {
        ch4_tonnes: 2.301,
        co2_tonnes: 51.552,
        n2o_tonnes: 0,
        co2e_tonnes: 120.124,
        gwp_set: 'AR6',
      },
      tier_summary: { 'Tier 3': 2 },
      lines: [],
    },
    ghgemp_report: {
      report_type: 'GHG Emissions Accounting & Inventory',
      jurisdiction: 'Nigeria (NUPRC)',
      operator: 'Demo E&P',
      asset: 'OML-1',
      facility_id: 'FAC-1',
      reporting_period: '2026-Q3',
      prepared_by: 'PetroBrain MRV',
      generated_utc: '2026-05-29T12:00:00+00:00',
      gwp_basis: 'IPCC AR6 GWP100',
      summary: {
        total_co2e_tonnes: 120.124,
        total_ch4_tonnes: 2.301,
        total_co2_tonnes: 51.552,
        total_n2o_tonnes: 0,
      },
      tier_status: {
        target_tier: 'Tier 3',
        lines_by_tier: { 'Tier 3': 2 },
        tier_readiness_pct: 100,
        gaps_to_target: [],
      },
      source_inventory: [],
      methodology_notes: [],
      compliance_flags: [],
      audit_sha256: '',
    },
    mrv_readiness: {
      status: 'ready_for_target_tier',
      facility_id: 'FAC-1',
      reporting_period: '2026-Q3',
      target_tier: 'Tier 3',
      tier_readiness_pct: 100,
      gap_count: 0,
      priority_gaps: [],
      gap_action_plan: [],
      total_co2e_tonnes: 120.124,
      total_ch4_tonnes: 2.301,
      compliance_flags: [],
      next_actions: [],
      audit_sha256: '',
    },
  };
  return { ...base, ...overrides };
}

describe('KpiCards', () => {
  it('renders the three KPI numbers verbatim from the response', () => {
    const { container } = render(<KpiCards response={fixture()} />);
    const labels = ['Total CO₂e', 'Total CH₄', 'Tier readiness'];
    for (const label of labels) {
      expect(within(container).getByText(label)).toBeInTheDocument();
    }
    // Numbers come straight from the response - no rounding surprises.
    expect(screen.getByText('120.124')).toBeInTheDocument();
    expect(screen.getByText('2.301')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('AR6')).toBeInTheDocument();
    expect(screen.getByText(/target Tier 3/)).toBeInTheDocument();
  });

  it('tints the readiness badge danger below 60% and warn between 60 and 95', () => {
    const { rerender } = render(<KpiCards response={withReadiness(40)} />);
    expect(toneOfBadge(screen.getByText(/target Tier 3/))).toBe('danger');
    rerender(<KpiCards response={withReadiness(75)} />);
    expect(toneOfBadge(screen.getByText(/target Tier 3/))).toBe('warn');
    rerender(<KpiCards response={withReadiness(98)} />);
    expect(toneOfBadge(screen.getByText(/target Tier 3/))).toBe('safe');
  });
});

function withReadiness(pct: number): InventoryResponse {
  const f = fixture();
  return {
    ...f,
    ghgemp_report: {
      ...f.ghgemp_report,
      tier_status: { ...f.ghgemp_report.tier_status, tier_readiness_pct: pct },
    },
  };
}

function toneOfBadge(badgeChild: HTMLElement): 'safe' | 'warn' | 'danger' | 'neutral' {
  const span = badgeChild.closest('span');
  if (!span) return 'neutral';
  const cls = span.className;
  if (cls.includes('bg-safe-bg')) return 'safe';
  if (cls.includes('bg-warn-bg')) return 'warn';
  if (cls.includes('bg-danger-bg')) return 'danger';
  return 'neutral';
}
