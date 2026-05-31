'use client';

import { useState, type FormEvent } from 'react';

import { Banner, Button, Card, Input, Select } from '@petrobrain/ui';

import type { InventoryRequest } from '@/lib/emissions/types';

const GWP_SETS = [
  { value: 'AR6', label: 'IPCC AR6 (default)' },
  { value: 'AR5', label: 'IPCC AR5' },
  { value: 'AR4', label: 'IPCC AR4' },
];
const TARGET_TIERS = [
  { value: 'Tier 3', label: 'Tier 3 - measurement-based' },
  { value: 'Tier 2', label: 'Tier 2 - factor-based' },
  { value: 'Tier 1', label: 'Tier 1 - default factors' },
];

const SAMPLE_SOURCES = JSON.stringify(
  [
    {
      source_id: 'FL-1',
      source_type: 'flaring',
      params: {
        gas_volume_scf: 1_000_000,
        composition: { CH4: 1.0 },
        combustion_efficiency: 0.98,
        measured: true,
      },
    },
  ],
  null,
  2,
);

export interface InventoryBuilderProps {
  defaultFacility?: string;
  defaultPeriod?: string;
  defaultOperator?: string;
  defaultAsset?: string;
  pending: boolean;
  error: string | null;
  onSubmit: (request: InventoryRequest) => void;
  onCancel: () => void;
}

/**
 * Pragmatic Phase-1 builder.
 *
 * Sources are entered as JSON - the underlying ``MRVRequest`` carries an
 * array of typed sources with shape-varying ``params``, and a proper
 * per-source-type wizard belongs to a later task. Engineers can paste
 * directly from the SOP / spreadsheet they own today.
 */
export function InventoryBuilder({
  defaultFacility = '',
  defaultPeriod = '',
  defaultOperator = '',
  defaultAsset = '',
  pending,
  error,
  onSubmit,
  onCancel,
}: InventoryBuilderProps) {
  const [facility, setFacility] = useState(defaultFacility);
  const [period, setPeriod] = useState(defaultPeriod);
  const [operator, setOperator] = useState(defaultOperator);
  const [asset, setAsset] = useState(defaultAsset);
  const [gwpSet, setGwpSet] = useState('AR6');
  const [targetTier, setTargetTier] = useState('Tier 3');
  const [sourcesText, setSourcesText] = useState(SAMPLE_SOURCES);
  const [parseError, setParseError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setParseError(null);

    let sources: InventoryRequest['sources'];
    try {
      const parsed = JSON.parse(sourcesText) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('sources must be a JSON array');
      }
      sources = parsed as InventoryRequest['sources'];
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      return;
    }

    const request: InventoryRequest = {
      facility_id: facility.trim(),
      period: period.trim(),
      operator: operator.trim(),
      asset: asset.trim() || null,
      gwp_set: gwpSet,
      target_tier: targetTier,
      sources,
    };
    onSubmit(request);
  }

  return (
    <Card title="Generate inventory" description="POST /emissions/inventory">
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            label="Facility ID"
            placeholder="FAC-1"
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            required
            disabled={pending}
          />
          <Input
            label="Period"
            placeholder="2026-Q3"
            hint="YYYY-Qn for quarterly filings."
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
            disabled={pending}
          />
          <Input
            label="Operator"
            placeholder="Operator name"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            required
            disabled={pending}
          />
          <Input
            label="Asset"
            placeholder="OML-99 (optional)"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            disabled={pending}
          />
          <Select
            label="GWP set"
            value={gwpSet}
            onChange={(e) => setGwpSet(e.target.value)}
            options={GWP_SETS}
            disabled={pending}
          />
          <Select
            label="Target tier"
            value={targetTier}
            onChange={(e) => setTargetTier(e.target.value)}
            options={TARGET_TIERS}
            disabled={pending}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="sources-json" className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            Sources (JSON)
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Array of <code className="font-mono">{'{source_id, source_type, params}'}</code>.
            <code className="font-mono">source_type</code> is one of: flaring, venting, fugitive_t2,
            fugitive_t3, combustion.
          </p>
          <textarea
            id="sources-json"
            rows={12}
            value={sourcesText}
            onChange={(e) => setSourcesText(e.target.value)}
            spellCheck={false}
            disabled={pending}
            className="w-full rounded-md border border-neutral-300 bg-white p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:ring-primary-500"
          />
          {parseError ? (
            <p role="alert" className="text-xs text-danger-fg dark:text-danger-bg">
              JSON parse error - {parseError}
            </p>
          ) : null}
        </div>

        {error ? (
          <Banner tone="danger" title="Backend rejected the request">
            {error}
          </Banner>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending} loading={pending}>
            Generate GHGEMP report
          </Button>
        </div>
      </form>
    </Card>
  );
}
