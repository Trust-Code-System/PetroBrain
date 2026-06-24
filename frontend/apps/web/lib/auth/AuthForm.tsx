'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Logo } from '@petrobrain/ui';

import { useChatStore } from '@/lib/chat/store';
import { useSettingsStore } from '@/lib/chat/settings';

import {
  AuthError,
  enroll2fa,
  isMfaChallenge,
  signin,
  signup,
  verify2fa,
  type AuthResponse,
  type MfaChallenge,
  type MfaEnrollData,
} from './api';
import { QrCode } from './QrCode';

export type AuthMode = 'signin' | 'signup';

interface AuthFormProps {
  mode: AuthMode;
}

const COPY: Record<AuthMode, {
  eyebrow: string;
  title: string;
  subtitle: string;
  submit: string;
  busy: string;
  switchPrompt: string;
  switchLabel: string;
  switchHref: '/signin' | '/signup/account-type';
  showConfirm: boolean;
}> = {
  signin: {
    eyebrow: 'PetroBrain',
    title: 'Sign in',
    subtitle: 'Welcome back. Sign in to your operations console.',
    submit: 'Sign in',
    busy: 'Signing in...',
    switchPrompt: "Don't have an account?",
    switchLabel: 'Create one',
    switchHref: '/signup/account-type',
    showConfirm: false,
  },
  signup: {
    eyebrow: 'PetroBrain',
    title: 'Create your account',
    subtitle: 'Sign up to start using the PetroBrain operations console.',
    submit: 'Create account',
    busy: 'Creating account...',
    switchPrompt: 'Already have an account?',
    switchLabel: 'Sign in',
    switchHref: '/signin',
    showConfirm: true,
  },
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * User-facing message for the "we just signed you out because your token
 * is no longer valid" banner on the signin page. Tone is informative, not
 * alarming - this is a normal end-of-day event, not an incident.
 */
function sessionExpiredCopy(reason: 'expired' | 'revoked' | 'invalid'): string {
  if (reason === 'revoked') {
    return 'Your session was ended by an admin or by signing out elsewhere. Sign in again to continue.';
  }
  if (reason === 'invalid') {
    return 'Your sign-in is no longer valid. Sign in again to continue.';
  }
  return 'Your session expired - sign in again to continue.';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const setSession = useChatStore((s) => s.setSession);
  const sessionExpiredReason = useChatStore((s) => s.sessionExpiredReason);
  const clearSessionExpired = useChatStore((s) => s.clearSessionExpired);
  const setCallMeName = useSettingsStore((s) => s.setCallMeName);
  const copy = COPY[mode];

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Surfaces a neutral progress note after a few seconds of busy so the user
  // knows the sign-in request is still in progress.
  const [slow, setSlow] = useState(false);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when the password step succeeds but a second factor is still required;
  // swaps the credentials card for the 2FA step. recoveryCodes/pendingRoute are
  // the one-time codes shown right after enrollment, before we route on.
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [pendingRoute, setPendingRoute] = useState<Route | null>(null);

  function completeWithSession(res: AuthResponse) {
    const cleanedEmail = email.trim();
    setSession(res.token, res.refresh_token, {
      ...res.principal,
      email: res.principal.email || cleanedEmail,
    });
    clearSessionExpired();
    if (mode === 'signup' && name.trim()) setCallMeName(name.trim());
    if (mode === 'signup' && typeof window !== 'undefined') {
      sessionStorage.removeItem('petrobrain-signup-account-type');
    }
    const target = (res.onboarding_required ? '/onboarding' : '/chat') as Route;
    // Recovery codes only come back on the turn that completes enrollment; show
    // them once (the user must save them) before routing into the app.
    if (res.recovery_codes && res.recovery_codes.length > 0) {
      setRecoveryCodes(res.recovery_codes);
      setPendingRoute(target);
    } else {
      router.push(target);
    }
  }

  useEffect(() => {
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, []);

  function validate(): string | null {
    const cleaned = email.trim();
    if (mode === 'signup' && !name.trim()) return 'Please enter your name.';
    if (!EMAIL_RE.test(cleaned)) return 'Please enter a valid email address.';
    if (!password) return 'Password is required.';
    if (mode === 'signup') {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
      }
      if (password !== confirm) return 'Passwords do not match.';
    }
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const localError = validate();
    if (localError) {
      setError(localError);
      return;
    }
    setError(null);
    setBusy(true);
    setSlow(false);
    // Long-request guard: show a neutral status after a short delay, and
    // hard-abort after 60 seconds so the form can never sit indefinitely.
    slowTimerRef.current = setTimeout(() => setSlow(true), 6000);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60_000);
    try {
      const cleanedEmail = email.trim();
      const requestedType = searchParams.get('account_type');
      const storedType = typeof window !== 'undefined'
        ? sessionStorage.getItem('petrobrain-signup-account-type')
        : null;
      const accountType = requestedType === 'individual' || requestedType === 'company'
        ? requestedType
        : storedType === 'individual' || storedType === 'company'
          ? storedType
          : undefined;
      const res = mode === 'signup'
        ? await signup(apiBaseUrl, {
            email: cleanedEmail,
            password,
            full_name: name.trim(),
            ...(accountType ? { account_type: accountType } : {}),
          }, controller.signal)
        : await signin(apiBaseUrl, { email: cleanedEmail, password }, controller.signal);
      if (isMfaChallenge(res)) {
        // Password accepted, second factor still required. Swap to the 2FA step;
        // the credentials are not kept past this point.
        setChallenge(res);
        setBusy(false);
        setSlow(false);
        return;
      }
      completeWithSession(res);
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
      } else if ((err as { name?: string }).name === 'AbortError') {
        setError('Sign-in took too long. Please wait a moment and try again.');
      } else {
        setError('Could not complete sign-in. Check your connection and try again.');
      }
      setBusy(false);
      setSlow(false);
    } finally {
      clearTimeout(abortTimer);
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
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
            {copy.eyebrow}
          </p>
          <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-2xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400 sm:text-3xl">
            {copy.title}
          </h1>
          <p className="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            {recoveryCodes ? 'Save your recovery codes' : challenge ? 'Two-factor authentication' : copy.subtitle}
          </p>
        </div>

        {recoveryCodes ? (
          <RecoveryCodesCard
            codes={recoveryCodes}
            onContinue={() => { if (pendingRoute) router.push(pendingRoute); }}
          />
        ) : challenge ? (
          <TwoFactorStep
            baseUrl={apiBaseUrl}
            challenge={challenge}
            onComplete={completeWithSession}
          />
        ) : (
        <>
        <form
          onSubmit={submit}
          aria-label={copy.title}
          className="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-6 shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70"
        >
          {mode === 'signup' ? (
            <div className="space-y-1.5">
              <label
                htmlFor="auth-name"
                className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
              >
                Name
              </label>
              <input
                id="auth-name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should we call you?"
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label
              htmlFor="auth-email"
              className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
            >
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              autoComplete={mode === 'signup' ? 'email' : 'username'}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="auth-password"
                className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
              >
                Password
              </label>
              {mode === 'signin' ? (
                <Link
                  href={'/forgot-password' as Route}
                  className="text-xs font-medium text-primary-700 hover:underline dark:text-primary-300"
                >
                  Forgot password?
                </Link>
              ) : null}
            </div>
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? MIN_PASSWORD_LENGTH : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'}
              className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
            />
          </div>

          {copy.showConfirm ? (
            <div className="space-y-1.5">
              <label
                htmlFor="auth-confirm"
                className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
              >
                Confirm password
              </label>
              <input
                id="auth-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter your password"
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
              />
            </div>
          ) : null}

          {mode === 'signin' && sessionExpiredReason && !error ? (
            <p
              role="status"
              className="rounded-xl border border-primary-200 bg-primary-50/70 px-3 py-2 text-xs font-medium text-primary-700 dark:border-primary-700/40 dark:bg-primary-900/30 dark:text-primary-200"
            >
              {sessionExpiredCopy(sessionExpiredReason)}
            </p>
          ) : null}

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
            {busy ? copy.busy : copy.submit}
          </button>

          {busy && slow ? (
            <p
              role="status"
              aria-live="polite"
              className="text-center text-[11px] text-neutral-500 dark:text-neutral-400"
            >
              Still signing you in. This can take a moment.
            </p>
          ) : null}

          <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">
            {copy.switchPrompt}{' '}
            <Link
              href={copy.switchHref as Route}
              className="font-semibold text-primary-700 hover:underline dark:text-primary-300"
            >
              {copy.switchLabel}
            </Link>
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          By {mode === 'signup' ? 'creating an account' : 'signing in'} you confirm you are
          authorised to access this tenant&apos;s operations data.
        </p>
        </>
        )}
      </div>
    </main>
  );
}

/**
 * Second-factor step shown after the password is accepted. If the user is not
 * yet enrolled it provisions a TOTP secret and shows the manual setup key plus
 * an "open in authenticator" link (better than a QR on a mobile-only device,
 * where you can't scan your own screen); enrolled users just enter a code.
 */
function TwoFactorStep({
  baseUrl,
  challenge,
  onComplete,
}: {
  baseUrl: string;
  challenge: MfaChallenge;
  onComplete: (res: AuthResponse) => void;
}) {
  const [enrollData, setEnrollData] = useState<MfaEnrollData | null>(null);
  const [loadingEnroll, setLoadingEnroll] = useState(!challenge.enrolled);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (challenge.enrolled) return;
    let active = true;
    enroll2fa(baseUrl, challenge.mfa_token)
      .then((data) => { if (active) setEnrollData(data); })
      .catch((e) => {
        if (active) {
          setErr(e instanceof AuthError ? e.message : 'Could not start two-factor setup.');
        }
      })
      .finally(() => { if (active) setLoadingEnroll(false); });
    return () => { active = false; };
  }, [baseUrl, challenge]);

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const cleaned = code.trim();
    if (!cleaned) { setErr('Enter the code from your authenticator app.'); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await verify2fa(baseUrl, { mfa_token: challenge.mfa_token, code: cleaned });
      onComplete(res);
    } catch (e) {
      setErr(e instanceof AuthError ? e.message : 'Could not verify the code. Try again.');
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollData) return;
    try {
      await navigator.clipboard.writeText(enrollData.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the key is visible to type manually anyway.
    }
  }

  const inputCls =
    'h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-center text-lg tracking-[0.3em] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500';

  return (
    <form
      onSubmit={submitCode}
      aria-label="Two-factor authentication"
      className="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-6 shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70"
    >
      {!challenge.enrolled ? (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            Scan this QR code with an authenticator app (Google Authenticator, Authy,
            1Password), then enter the 6-digit code it shows.
          </p>
          {loadingEnroll ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Preparing setup…</p>
          ) : enrollData ? (
            <div className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 dark:border-neutral-700 dark:bg-neutral-900/60">
              <div className="flex justify-center">
                <QrCode value={enrollData.otpauth_uri} />
              </div>
              <a
                href={enrollData.otpauth_uri}
                className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-primary-300 bg-primary-50 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-100 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-200"
              >
                On this phone? Open in authenticator app
              </a>
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Can&apos;t scan? Enter this key manually
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
                  {enrollData.secret}
                </code>
                <button
                  type="button"
                  onClick={copySecret}
                  className="shrink-0 rounded-md border border-neutral-200 px-2 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          Enter the 6-digit code from your authenticator app. You can also use one of your
          recovery codes.
        </p>
      )}

      <div className="space-y-1.5">
        <label htmlFor="mfa-code" className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
          Authentication code
        </label>
        <input
          id="mfa-code"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
          className={inputCls}
        />
      </div>

      {err ? (
        <p role="alert" className="rounded-xl border border-danger-border/70 bg-danger-bg/60 px-3 py-2 text-xs font-medium text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
          {err}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || loadingEnroll}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-primary-500 to-primary-700 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Verifying…' : challenge.enrolled ? 'Verify and sign in' : 'Verify and finish setup'}
      </button>
    </form>
  );
}

/**
 * One-time recovery codes shown immediately after enrollment. The user must
 * save these; they are the only way back in if the authenticator is lost.
 */
function RecoveryCodesCard({
  codes,
  onContinue,
}: {
  codes: string[];
  onContinue: () => void;
}) {
  const [ack, setAck] = useState(false);

  function copyAll() {
    void navigator.clipboard?.writeText(codes.join('\n')).catch(() => {});
  }

  return (
    <div className="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-6 shadow-brand-md backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70">
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        Save these recovery codes somewhere safe. Each works once if you lose access to your
        authenticator. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900/60">
        {codes.map((c) => (
          <li key={c} className="text-neutral-800 dark:text-neutral-100">{c}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={copyAll}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-neutral-200 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        Copy codes
      </button>
      <label className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5"
        />
        I have saved my recovery codes.
      </label>
      <button
        type="button"
        disabled={!ack}
        onClick={onContinue}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-primary-500 to-primary-700 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Continue
      </button>
    </div>
  );
}
