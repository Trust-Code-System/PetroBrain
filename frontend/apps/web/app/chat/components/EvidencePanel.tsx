'use client';

import type { EvidencePack } from '@petrobrain/types';

export function EvidencePanel({ evidence }: { evidence: EvidencePack | null }) {
  if (!evidence) return null;
  const checked = Array.isArray(evidence.checked) ? evidence.checked : [];
  const notVerified = Array.isArray(evidence.not_verified) ? evidence.not_verified : [];
  const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
  const calculations = Array.isArray(evidence.calculations)
    ? evidence.calculations.map((calculation) => ({
        ...calculation,
        outputs: Array.isArray(calculation?.outputs) ? calculation.outputs : [],
        formulas: Array.isArray(calculation?.formulas) ? calculation.formulas : [],
      }))
    : [];
  const hasDetails =
    checked.length > 0 ||
    notVerified.length > 0 ||
    sources.length > 0 ||
    calculations.length > 0;
  if (!hasDetails) return null;

  const confidence = evidence.confidence ?? { label: 'Unknown', reason: '' };
  const safety = evidence.safety ?? { requires_human_verification: false, message: '' };

  return (
    <details className="rounded-xl border border-neutral-200/80 bg-white/70 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">Verification</span>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {confidence.label}
        </span>
      </summary>

      <div className="mt-3 space-y-3 text-neutral-700 dark:text-neutral-300">
        {evidence.advisory?.required ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-blue-900 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-100">
            {evidence.advisory.message}
          </p>
        ) : null}
        {safety.requires_human_verification ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
            {safety.message}
          </p>
        ) : null}

        <Section title="What I checked" rows={checked} />
        <Sources sources={sources} />
        <Calculations calculations={calculations} />
        <Section title="Not verified" rows={notVerified} muted />

        {confidence.reason ? (
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            Confidence: {confidence.reason}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function Section({ title, rows, muted = false }: { title: string; rows: string[]; muted?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-1">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
        {title}
      </h4>
      <ul className={muted ? 'space-y-1 text-neutral-500 dark:text-neutral-400' : 'space-y-1'}>
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </section>
  );
}

function Sources({ sources }: { sources: EvidencePack['sources'] }) {
  if (sources.length === 0) return null;
  return (
    <section className="space-y-1">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
        Sources
      </h4>
      <ul className="flex flex-wrap gap-1">
        {sources.map((source, i) => (
          <li key={`${source.label}-${i}`}>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-700 hover:border-primary-300 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                {source.label}
                <SourceQuality source={source} />
              </a>
            ) : (
              <span className="inline-flex rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                {source.label}
                <SourceQuality source={source} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceQuality({ source }: { source: EvidencePack['sources'][number] }) {
  if (!source.reliability) return null;
  return (
    <span className="ml-1 border-l border-neutral-300 pl-1 text-[9px] uppercase text-neutral-500 dark:border-neutral-600 dark:text-neutral-400">
      {source.reliability}
      {typeof source.quality_score === 'number' ? ` ${source.quality_score}/100` : ''}
    </span>
  );
}

function Calculations({ calculations }: { calculations: EvidencePack['calculations'] }) {
  if (calculations.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
        Calculations
      </h4>
      <div className="space-y-2">
        {calculations.map((calc) => (
          <div key={calc.label} className="rounded-lg border border-neutral-200 bg-neutral-50/80 p-2 dark:border-neutral-700 dark:bg-neutral-800/50">
            <p className="font-semibold text-neutral-800 dark:text-neutral-100">{calc.label}</p>
            {calc.outputs.length > 0 ? (
              <dl className="mt-1 grid gap-1 sm:grid-cols-2">
                {calc.outputs.map((out) => (
                  <div key={out.label}>
                    <dt className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{out.label}</dt>
                    <dd className="font-medium text-neutral-800 dark:text-neutral-100">{String(out.value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {calc.formulas.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
                {calc.formulas.map((formula) => (
                  <li key={formula}>{formula}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
