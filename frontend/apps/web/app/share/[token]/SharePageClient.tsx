'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Banner, Logo } from '@petrobrain/ui';

import { AuthGate } from '../../chat/components/AuthGate';
import { MessageList } from '../../chat/components/MessageList';
import { useChatStore } from '@/lib/chat/store';
import { fetchShare, ShareApiError, type ShareRecord } from '@/lib/chat/shares';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; share: ShareRecord }
  | { kind: 'not-found' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string };

export function SharePageClient() {
  const params = useParams<{ token: string }>();
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const hasHydrated = useChatStore((s) => s.hasHydrated);

  const shareToken = typeof params?.token === 'string' ? params.token : '';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!hasHydrated || !token || !shareToken) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchShare(apiBaseUrl, token, shareToken)
      .then((share) => {
        if (!cancelled) setState({ kind: 'ready', share });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ShareApiError) {
          if (err.status === 404) setState({ kind: 'not-found' });
          else if (err.status === 410) setState({ kind: 'gone' });
          else setState({ kind: 'error', message: err.message });
        } else {
          setState({ kind: 'error', message: 'Could not load shared conversation.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasHydrated, token, apiBaseUrl, shareToken]);

  if (!hasHydrated) return <LoadingScreen label="Loading PetroBrain" />;
  if (!token || !principal) return <AuthGate />;
  if (state.kind === 'loading') return <LoadingScreen label="Loading shared conversation" />;
  if (state.kind === 'not-found') {
    return (
      <Message
        title="Share not found"
        body="This link does not exist, or it was created in a different tenant. Ask the person who shared it to verify the link, or sign in with the right account."
      />
    );
  }
  if (state.kind === 'gone') {
    return (
      <Message
        title="Share unavailable"
        body="This link has either been revoked by its owner or expired (shares last 30 days). Ask for a fresh link."
      />
    );
  }
  if (state.kind === 'error') {
    return <Message title="Could not load share" body={state.message} />;
  }

  const { share } = state;
  const snapshot = share.snapshot;
  const messages = snapshot?.messages ?? [];
  const expiresAt = new Date(share.expires_utc);

  return (
    <main className="relative min-h-screen bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-[-10%] h-96 w-96 rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
      />
      <header className="relative z-10 mx-auto flex max-w-3xl flex-col gap-3 px-6 pt-10">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary-700 hover:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200"
          >
            <Logo size={28} glow />
            PetroBrain
          </Link>
          <span className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
            Shared conversation
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {share.title}
        </h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Snapshot taken {new Date(share.created_utc).toLocaleString()} - expires{' '}
          {expiresAt.toLocaleDateString()}
        </p>
      </header>

      <div className="relative z-10 mx-auto mt-6 max-w-3xl px-6">
        <Banner tone="brand" title="DECISION SUPPORT ONLY">
          Verify all safety-critical numbers with the competent person before acting. This is a
          read-only snapshot - edits made after the share was created do not appear here.
        </Banner>
      </div>

      {messages.length === 0 ? (
        <div className="relative z-10 mx-auto mt-12 max-w-3xl px-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          This conversation is empty.
        </div>
      ) : (
        <div className="relative z-10 pb-12 pt-2">
          <MessageList messages={messages} />
        </div>
      )}
    </main>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="relative inline-flex h-12 w-12">
          <span className="absolute inset-0 rounded-full bg-primary-200/60 blur-xl dark:bg-primary-700/40" />
          <span
            aria-hidden
            className="relative inline-block h-12 w-12 rounded-full border-2 border-primary-200 border-t-primary-500 animate-spin dark:border-primary-800"
          />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-400">
          {label}
        </span>
      </div>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 px-6 py-10 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5">
          <Logo size={44} glow />
        </div>
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{body}</p>
        <Link
          href="/chat"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-gradient-to-b from-primary-500 to-primary-700 px-4 py-2 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600"
        >
          Go to PetroBrain
        </Link>
      </div>
    </main>
  );
}
