import type { InventoryResponse } from '@/lib/emissions/types';

import { KpiCards } from './KpiCards';
import { ReportViewer } from './ReportViewer';
import { SourceTable } from './SourceTable';

export function InventoryViewer({ response }: { response: InventoryResponse }) {
  return (
    <div className="space-y-6">
      <KpiCards response={response} />
      <section className="space-y-2" aria-label="Sources">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
            Sources - {response.inventory.lines.length}
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Tier 3 rows tinted green, Tier 2 amber, Tier 1 red.
          </p>
        </header>
        <SourceTable lines={response.inventory.lines} />
      </section>
      <ReportViewer report={response.ghgemp_report} />
    </div>
  );
}
