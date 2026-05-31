'use client';

import { Badge, Banner, Button, Card } from '@petrobrain/ui';

import type { GhgempReport } from '@/lib/emissions/types';

export interface ReportViewerProps {
  report: GhgempReport;
}

/**
 * GHGEMP report viewer with Download JSON + Print to PDF.
 *
 * The report comes back already typeset by ``ghgemp_template.py``; we
 * just present it. Print uses the browser dialog (engineers usually
 * route to "Save as PDF" from there). Download produces a JSON blob with
 * the exact bytes the backend hashed into ``audit_sha256`` so the file
 * the operator files matches what the audit log records.
 */
export function ReportViewer({ report }: ReportViewerProps) {
  function download() {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ghgemp_${report.facility_id}_${report.reporting_period}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function print() {
    if (typeof window !== 'undefined') window.print();
  }

  return (
    <section className="space-y-3 print:break-before-page" aria-label="GHGEMP report">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">{report.report_type}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {report.operator} · {report.asset ?? 'no asset'} · {report.jurisdiction}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button variant="secondary" size="sm" onClick={download}>
            Download JSON
          </Button>
          <Button variant="primary" size="sm" onClick={print}>
            Print to PDF
          </Button>
        </div>
      </header>

      <Banner tone="info" title="Verify against current NUPRC guidance">
        Confirm GWP set and emission factors against current NUPRC gazetted guidance and the
        operator&apos;s applicable IPCC tier before filing. PetroBrain is decision support -
        submissions remain the operator&apos;s responsibility.
      </Banner>

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <Field label="Facility">{report.facility_id}</Field>
          <Field label="Period">{report.reporting_period}</Field>
          <Field label="GWP basis">{report.gwp_basis}</Field>
          <Field label="Total CO₂e (t)">
            {report.summary.total_co2e_tonnes.toLocaleString()}
          </Field>
          <Field label="Total CH₄ (t)">
            {report.summary.total_ch4_tonnes.toLocaleString()}
          </Field>
          <Field label="Tier readiness">
            <span className="tabular-nums">{report.tier_status.tier_readiness_pct}%</span>{' '}
            <span className="text-xs text-neutral-500 dark:text-neutral-400">→ {report.tier_status.target_tier}</span>
          </Field>
          <Field label="Generated (UTC)">{report.generated_utc.slice(0, 19)}Z</Field>
          <Field label="Audit hash">
            <code className="break-all font-mono text-xs">{report.audit_sha256}</code>
          </Field>
        </dl>
      </Card>

      {report.tier_status.gaps_to_target.length > 0 ? (
        <Card title="Gaps to target tier">
          <ul className="space-y-1 text-sm">
            {report.tier_status.gaps_to_target.map((gap, i) => (
              <li key={i} className="rounded-md border border-warn-border bg-warn-bg/40 p-2 dark:border-warn-border/40 dark:bg-warn-fg/20 dark:text-warn-bg">
                <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(gap, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {report.compliance_flags.length > 0 ? (
        <Card title="Compliance flags">
          <div className="flex flex-wrap gap-2">
            {report.compliance_flags.map((flag) => (
              <Badge key={flag} tone="danger">
                {flag}
              </Badge>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="Methodology notes">
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {report.methodology_notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="mt-0.5 text-neutral-800 dark:text-neutral-200">{children}</dd>
    </div>
  );
}
