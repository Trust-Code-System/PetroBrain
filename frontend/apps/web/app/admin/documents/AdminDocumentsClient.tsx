'use client';

import { AuthGate } from '../../chat/components/AuthGate';
import { useChatStore } from '@/lib/chat/store';

import { DocumentsScreen } from './components/DocumentsScreen';
import { Forbidden } from './components/Forbidden';

export function AdminDocumentsClient() {
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const hasHydrated = useChatStore((s) => s.hasHydrated);

  if (!hasHydrated) {
    return (
      <div
        aria-busy="true"
        className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
      >
        <span className="relative inline-flex h-12 w-12">
          <span className="absolute inset-0 rounded-full bg-primary-200/60 blur-xl dark:bg-primary-700/40" />
          <span
            aria-hidden
            className="relative inline-block h-12 w-12 rounded-full border-2 border-primary-200 border-t-primary-500 animate-spin dark:border-primary-800"
          />
        </span>
      </div>
    );
  }
  if (!token || !principal) return <AuthGate />;
  if (principal.role !== 'admin') return <Forbidden role={principal.role} />;
  return <DocumentsScreen />;
}
