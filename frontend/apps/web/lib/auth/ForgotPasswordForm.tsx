'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Logo } from '@petrobrain/ui';

import { useChatStore } from '@/lib/chat/store';

import { AuthError, requestPasswordReset } from './api';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * "Forgot your password?" entry point. Posts the email to the enumeration-safe
 * /auth/forgot-password endpoint and always lands on the same neutral
 * confirmation, so this screen never reveals whether an email is registered.
 */
export function ForgotPasswordForm() {
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const cleaned = email.trim();
    if (!EMAIL_RE.test(cleaned)) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const abortTimer = setTimeout(() => controller.abort(), 60_000);
    try {
      const message = await requestPasswordReset(apiBaseUrl, cleaned, controller.signal);
      setConfirmation(message);
      setSent(true);
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
      } else if ((err as { name?: string }).name === 'AbortError') {
        setError('That took too long. Please wait a moment and try again.');
      } else {
        setError('Could not send the reset link. Check your connection and try again.');
      }
    } finally {
      clearTimeout(abortTimer);
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-100/40 blur-3xl dark:bg-primary-900/20"
      />

      <div className="relative w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={56} glow />
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-600 dark:text-primary-400">
            PetroBrain
          </p>
          <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-2xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400 sm:text-3xl">
            {sent ? 'Check your email' : 'Reset your password'}
          </h1>
          <p className="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            {sent
              ? confirmation
              : 'Enter your account email and we will send you a link to set a new password.'}
          </p>
        </div>

        {sent ? (
          <div className="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-6 text-center shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              The link expires soon and can be used once. If it does not arrive, check your
              spam folder or try again.
            </p>
            <Link
              href="/signin"
              className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-gradient-to-b from-primary-500 to-primary-700 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form
            onSubmit={submit}
            aria-label="Reset your password"
            className="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-6 shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="forgot-email"
                className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
              >
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
              />
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-danger-border/70 bg-danger-bg/60 px-3 py-2 text-xs font-medium text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-primary-500 to-primary-700 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Sending link...' : 'Send reset link'}
            </button>

            <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">
              Remembered it?{' '}
              <Link
                href="/signin"
                className="font-semibold text-primary-700 hover:underline dark:text-primary-300"
              >
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
