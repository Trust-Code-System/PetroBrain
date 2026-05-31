'use client';

import { useQuery } from '@tanstack/react-query';

import { Badge, Banner, Card } from '@petrobrain/ui';

import { getDataReadiness } from '@/lib/admin-console/api';
import { missingAssetLevels, scoreTone, statusLine } from '@/lib/admin-console/score';
import type { DataReadiness } from '@/lib/admin-console/types';
import { useAdminSession } from '@/lib/session/store';

import { AdminShell } from '../../../AdminShell';
import { AuthGate } from '../../../AuthGate';

export function DataReadinessClient({ tenantId }: { tenantId: string }) {
  const token = useAdminSession((s) => s.token);
  const principal = useAdminSession((s) => s.principal);
  const apiBaseUrl = useAdminSession((s) => s.apiBaseUrl);

  if (!token || !principal) return <AuthGate />;

  if (
    principal.role !== 'platform_admin' &&
    !(principal.role === 'admin' && principal.tenantId === tenantId)
  ) {
    return (
      <AdminShell title="Forbidden" subtitle="">
        <Banner tone="danger" title="Cross-tenant access denied">
          Use a platform_admin token to read another tenant&apos;s readiness.
        </Banner>
      </AdminShell>
    );
  }

  // Data hooks live in the authed view so they run unconditionally (the gate
  // above can early-return before they would otherwise be reached).
  return <DataReadinessView tenantId={tenantId} token={token} apiBaseUrl={apiBaseUrl} />;
}

function DataReadinessView({
  tenantId,
  token,
  apiBaseUrl,
}: {
  tenantId: string;
  token: string;
  apiBaseUrl: string;
}) {
  const query = useQuery({
    queryKey: ['readiness', tenantId],
    queryFn: ({ signal }) =>
      getDataReadiness({ baseUrl: apiBaseUrl, token, tenantId, signal }),
  });

  return (
    <AdminShell
      title={`Data readiness - ${tenantId}`}
      subtitle="All numbers come from /admin/data-readiness - derived server-side from the existing stores."
    >
      {query.isError ? (
        <Banner tone="danger" title="Could not load readiness">
          {(query.error as Error)?.message ?? 'Check the API base URL and JWT.'}
        </Banner>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : query.data ? (
        <Body readiness={query.data} />
      ) : null}
    </AdminShell>
  );
}

function Body({ readiness }: { readiness: DataReadiness }) {
  const tone = scoreTone(readiness.readiness_pct);
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Readiness
            </p>
            <p className="mt-1 text-4xl font-semibold text-neutral-800 tabular-nums">
              {readiness.readiness_pct.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              <span className="ml-1 text-base font-normal text-neutral-500">%</span>
            </p>
            <p className="mt-2 text-sm text-neutral-600">{statusLine(readiness)}</p>
          </div>
          <Badge tone={tone}>{tone}</Badge>
        </div>
      </Card>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ScoreCard title="Documents" weight={readiness.weights.documents}>
          <Metric label="Loaded" value={readiness.documents.loaded} />
          <Metric label="Indexed" value={readiness.documents.indexed} />
          <Metric label="Failed" value={readiness.documents.failed} />
          <ScoreLine score={readiness.documents.score_pct} />
        </ScoreCard>

        <ScoreCard title="Asset hierarchy" weight={readiness.weights.assets}>
          <Metric label="Total" value={readiness.assets.total} />
          {Object.entries(readiness.assets.by_type).map(([type, count]) => (
            <Metric key={type} label={type} value={count} />
          ))}
          <ScoreLine score={readiness.assets.score_pct} />
          {missingAssetLevels(readiness.assets.by_type).length > 0 ? (
            <p className="mt-2 text-xs text-neutral-500">
              Missing levels:{' '}
              <span className="font-mono">
                {missingAssetLevels(readiness.assets.by_type).join(' · ')}
              </span>
            </p>
          ) : null}
        </ScoreCard>

        <ScoreCard title="Users" weight={readiness.weights.users}>
          <Metric label="Active" value={readiness.users.active} />
          <Metric label="Pending invites" value={readiness.users.pending_invites} />
          <ScoreLine score={readiness.users.score_pct} />
        </ScoreCard>

        <ScoreCard title="Connectors" weight={readiness.weights.connectors}>
          <Metric label="Status" value={readiness.connectors.status} />
          <p className="mt-2 text-xs text-neutral-500">{readiness.connectors.note}</p>
          <ScoreLine score={readiness.connectors.score_pct} />
        </ScoreCard>
      </section>
    </div>
  );
}

function ScoreCard({
  title,
  weight,
  children,
}: {
  title: string;
  weight: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">{title}</h3>
        <Badge tone="neutral">weight {Math.round(weight * 100)}%</Badge>
      </div>
      <div className="mt-3 space-y-1">{children}</div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="font-mono text-sm text-neutral-800">{String(value)}</span>
    </div>
  );
}

function ScoreLine({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <div className="mt-3 flex items-center justify-between">
      <span className="text-xs uppercase tracking-wide text-neutral-500">Component score</span>
      <Badge tone={tone}>{score.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</Badge>
    </div>
  );
}
