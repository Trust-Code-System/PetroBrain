'use client';

import { useState } from 'react';

import { Banner, Button, Input } from '@petrobrain/ui';

import { decodeAdminPrincipal } from '@/lib/session/jwt';
import { useAdminSession } from '@/lib/session/store';

/**
 * Dev sign-in for the admin console.
 *
 * A real deployment swaps this for SSO. The console explicitly accepts
 * platform-admin OR tenant-admin tokens - the rest of the UI gates per
 * route depending on the role.
 */
export function AuthGate() {
  const setToken = useAdminSession((s) => s.setToken);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const principal = decodeAdminPrincipal(trimmed);
    if (!principal) {
      setError('Token is not a valid PetroBrain JWT.');
      return;
    }
    if (principal.role !== 'platform_admin' && principal.role !== 'admin') {
      setError('Only platform_admin or admin tokens can sign into the admin console.');
      return;
    }
    setError(null);
    setToken(trimmed);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-800">PetroBrain - Admin</h1>
        <p className="text-sm text-neutral-500">
          Paste a JWT with the same <code className="font-mono">PB_JWT_SECRET</code> as the backend.
        </p>
      </header>
      <Banner tone="info" title="Dev only">
        SSO + device enrolment land later. Platform admins see every tenant; tenant admins see only
        their own.
      </Banner>
      <form className="space-y-3" onSubmit={submit} aria-label="Sign in">
        <Input
          label="JWT"
          placeholder="eyJhbGciOi..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...(error ? { error } : {})}
        />
        <Button type="submit" variant="primary">
          Continue
        </Button>
      </form>
    </main>
  );
}
