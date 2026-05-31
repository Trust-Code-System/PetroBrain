import { Banner } from '@petrobrain/ui';

export interface ForbiddenProps {
  role: string;
}

export function Forbidden({ role }: ForbiddenProps) {
  return (
    <main className="mx-auto max-w-xl space-y-3 p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-800 dark:text-neutral-100">403 - Forbidden</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          The document admin surface is restricted to platform administrators.
        </p>
      </header>
      <Banner tone="danger" title="Insufficient role">
        Your principal has role <code className="font-mono">{role}</code>. Ask a tenant admin to grant
        you the admin role, or sign in with an administrative account.
      </Banner>
    </main>
  );
}
