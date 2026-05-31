'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Logo } from '@petrobrain/ui';

/**
 * Surfaces that require auth render <AuthGate /> instead of their content when
 * no JWT is in the store. Rather than ask the user to paste one, send them to
 * the real sign-in page; that flow's onSuccess writes the token back into the
 * same store so this gate clears on the next render.
 */
export function AuthGate() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/signin');
  }, [router]);

  return (
    <main
      aria-busy="true"
      aria-label="Redirecting to sign in"
      className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
    >
      <div className="flex flex-col items-center gap-3">
        <Logo size={40} glow />
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
          Redirecting to sign in...
        </span>
      </div>
    </main>
  );
}
