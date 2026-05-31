import { Badge, Card } from '@petrobrain/ui';

import type { InventoryResponse } from '@/lib/emissions/types';

export interface KpiCardsProps {
  response: InventoryResponse;
}

/**
 * Top KPI strip for the MRV viewer.
 *
 * Every value is read straight from the backend response. No client-side
 * arithmetic - totals come from the inventory engine and tier-readiness
 * comes from the GHGEMP report builder.
 */
export function KpiCards({ response }: KpiCardsProps) {
  const totals = response.inventory.totals;
  const tier = response.ghgemp_report.tier_status;

  return (
    <section className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Inventory KPIs">
      <Kpi
        label="Total CO₂e"
        value={formatTonnes(totals.co2e_tonnes)}
        suffix="t"
        accessory={<Badge tone="info">{totals.gwp_set}</Badge>}
      />
      <Kpi
        label="Total CH₄"
        value={formatTonnes(totals.ch4_tonnes)}
        suffix="t"
        accessory={<Badge tone={totals.ch4_tonnes > 0 ? 'warn' : 'neutral'}>methane</Badge>}
      />
      <Kpi
        label="Tier readiness"
        value={formatPct(tier.tier_readiness_pct)}
        suffix="%"
        accessory={
          <Badge tone={readinessTone(tier.tier_readiness_pct)}>
            target {tier.target_tier}
          </Badge>
        }
      />
    </section>
  );
}

interface KpiProps {
  label: string;
  value: string;
  suffix: string;
  accessory: React.ReactNode;
}

function Kpi({ label, value, suffix, accessory }: KpiProps) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{label}</p>
          <p className="mt-1 text-3xl font-semibold text-neutral-800 tabular-nums dark:text-neutral-100">
            {value}
            <span className="ml-1 text-base font-normal text-neutral-500 dark:text-neutral-400">{suffix}</span>
          </p>
        </div>
        <div className="pt-1">{accessory}</div>
      </div>
    </Card>
  );
}

function formatTonnes(value: number): string {
  // 3 decimals = kg precision at tonne scale, matching the engine's
  // rounding. Localization handles thousands separators.
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatPct(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function readinessTone(pct: number): 'safe' | 'warn' | 'danger' {
  if (pct >= 95) return 'safe';
  if (pct >= 60) return 'warn';
  return 'danger';
}
