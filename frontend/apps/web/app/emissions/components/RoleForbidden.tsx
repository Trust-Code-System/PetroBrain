import { Banner } from '@petrobrain/ui';

/**
 * Emissions dashboards are office work - engineers, HSE, and admins.
 * Field-only principals get a 403 here (they have the field app instead).
 */
export function RoleForbidden({ role }: { role: string }) {
  return (
    <main className="mx-auto max-w-xl space-y-3 p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-800 dark:text-neutral-100">403 - Forbidden</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          The MRV dashboard is restricted to engineering, HSE, and admin roles.
        </p>
      </header>
      <Banner tone="danger" title="Insufficient role">
        Your principal has role <code className="font-mono">{role}</code>. Field principals should
        use the field app&apos;s emissions snapshot instead.
      </Banner>
    </main>
  );
}
