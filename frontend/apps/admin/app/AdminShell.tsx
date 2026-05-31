'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { Badge, Button } from '@petrobrain/ui';

import { useAdminSession } from '@/lib/session/store';

interface AdminShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/**
 * Top-bar + body wrapper for every admin route.
 */
export function AdminShell({ title, subtitle, children }: AdminShellProps) {
  const principal = useAdminSession((s) => s.principal);
  const setToken = useAdminSession((s) => s.setToken);
  const router = useRouter();

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/tenants" className="text-base font-semibold text-neutral-800">
              PetroBrain - Admin
            </Link>
            {principal ? (
              <span className="hidden md:inline text-sm text-neutral-500">
                <Badge tone={principal.role === 'platform_admin' ? 'info' : 'neutral'}>
                  {principal.role}
                </Badge>{' '}
                {principal.userId} · tenant {principal.tenantId}
              </span>
            ) : null}
          </div>
          {principal ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setToken(null);
                router.replace('/tenants');
              }}
            >
              Sign out
            </Button>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-neutral-800">{title}</h1>
          {subtitle ? <p className="text-sm text-neutral-500">{subtitle}</p> : null}
        </header>
        {children}
      </main>
    </div>
  );
}
