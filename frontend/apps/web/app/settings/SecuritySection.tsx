'use client';

import { useEffect, useState } from 'react';

import {
  AuthError,
  activate2fa,
  disable2fa,
  get2faStatus,
  regenerateRecoveryCodes,
  setup2fa,
  type MfaEnrollData,
  type MfaStatus,
} from '@/lib/auth/api';
import { QrCode } from '@/lib/auth/QrCode';

const cardCls =
  'rounded-xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-neutral-700 dark:bg-neutral-900/60';
const primaryBtn =
  'inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-b from-primary-500 to-primary-700 px-4 text-sm font-semibold text-white shadow-brand-primary transition-all hover:from-primary-400 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-60';
const ghostBtn =
  'inline-flex h-10 items-center justify-center rounded-xl border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800';
const codeInput =
  'h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-center text-lg tracking-[0.3em] focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof AuthError ? e.message : fallback;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        Save these recovery codes somewhere safe. Each works once if you lose your authenticator.
        They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-neutral-200 bg-white p-3 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950">
        {codes.map((c) => (
          <li key={c} className="text-neutral-800 dark:text-neutral-100">{c}</li>
        ))}
      </ul>
      <button
        type="button"
        className={ghostBtn}
        onClick={() => { void navigator.clipboard?.writeText(codes.join('\n')).catch(() => {}); }}
      >
        Copy codes
      </button>
    </div>
  );
}

export function SecuritySection({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enrollment sub-flow.
  const [enroll, setEnroll] = useState<MfaEnrollData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  // Management sub-flow (turn off / regenerate need a code).
  const [action, setAction] = useState<'disable' | 'regenerate' | null>(null);
  const [copied, setCopied] = useState(false);

  function refreshStatus() {
    setLoading(true);
    get2faStatus(baseUrl, token)
      .then((s) => setStatus(s))
      .catch((e) => setError(errMsg(e, 'Could not load your security settings.')))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let active = true;
    get2faStatus(baseUrl, token)
      .then((s) => { if (active) setStatus(s); })
      .catch((e) => { if (active) setError(errMsg(e, 'Could not load your security settings.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [baseUrl, token]);

  async function startSetup() {
    setError(null);
    setBusy(true);
    try {
      setEnroll(await setup2fa(baseUrl, token));
    } catch (e) {
      setError(errMsg(e, 'Could not start two-factor setup.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup() {
    if (busy) return;
    const c = code.trim();
    if (!c) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setError(null);
    setBusy(true);
    try {
      const { recovery_codes } = await activate2fa(baseUrl, token, c);
      setNewCodes(recovery_codes);
      setEnroll(null);
      setCode('');
      setStatus({ enabled: true, required: status?.required ?? false });
    } catch (e) {
      setError(errMsg(e, 'That code did not match. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (busy || !action) return;
    const c = code.trim();
    if (!c) { setError('Enter a code from your authenticator app.'); return; }
    setError(null);
    setBusy(true);
    try {
      if (action === 'disable') {
        const s = await disable2fa(baseUrl, token, c);
        setStatus(s);
      } else {
        const { recovery_codes } = await regenerateRecoveryCodes(baseUrl, token, c);
        setNewCodes(recovery_codes);
      }
      setAction(null);
      setCode('');
    } catch (e) {
      setError(errMsg(e, 'That code did not match. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  function copySecret() {
    if (!enroll) return;
    void navigator.clipboard?.writeText(enroll.secret).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }

  if (loading) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-xl border border-danger-border/70 bg-danger-bg/60 px-3 py-2 text-xs font-medium text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
          {error}
        </p>
      ) : null}

      {/* One-time recovery codes after enable / regenerate. */}
      {newCodes ? (
        <div className={cardCls}>
          <RecoveryCodes codes={newCodes} />
          <button type="button" className={`${primaryBtn} mt-3`} onClick={() => setNewCodes(null)}>
            Done
          </button>
        </div>
      ) : null}

      {/* Status line */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Two-factor authentication
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {status?.enabled
              ? 'On - a code from your authenticator app is required at sign-in.'
              : 'Add a second step at sign-in using an authenticator app.'}
            {status?.required ? ' Required by your organization.' : ''}
          </p>
        </div>
        <span
          className={
            status?.enabled
              ? 'rounded-full border border-safe-border/40 bg-safe-bg px-2.5 py-1 text-[11px] font-semibold text-safe-fg'
              : 'rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'
          }
        >
          {status?.enabled ? 'On' : 'Off'}
        </span>
      </div>

      {/* Not enrolled: setup flow */}
      {!status?.enabled && !newCodes ? (
        enroll ? (
          <div className={`${cardCls} space-y-3`}>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              Scan this QR code with your authenticator app (Google Authenticator, Authy,
              1Password), then enter the 6-digit code it shows.
            </p>
            <div className="flex justify-center">
              <QrCode value={enroll.otpauth_uri} />
            </div>
            <a href={enroll.otpauth_uri} className={`${ghostBtn} w-full`}>
              On this phone? Open in authenticator app
            </a>
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Can&apos;t scan? Enter this key manually
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
                  {enroll.secret}
                </code>
                <button type="button" className={ghostBtn} onClick={copySecret}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={codeInput}
            />
            <div className="flex gap-2">
              <button type="button" className={primaryBtn} disabled={busy} onClick={confirmSetup}>
                {busy ? 'Verifying…' : 'Verify and enable'}
              </button>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => { setEnroll(null); setCode(''); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={primaryBtn} disabled={busy} onClick={startSetup}>
            {busy ? 'Starting…' : 'Set up two-factor'}
          </button>
        )
      ) : null}

      {/* Enrolled: management actions */}
      {status?.enabled ? (
        action ? (
          <div className={`${cardCls} space-y-3`}>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {action === 'disable'
                ? 'Enter a current code to turn two-factor off.'
                : 'Enter a current code to generate new recovery codes (old ones stop working).'}
            </p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={codeInput}
            />
            <div className="flex gap-2">
              <button type="button" className={primaryBtn} disabled={busy} onClick={confirmAction}>
                {busy ? 'Working…' : action === 'disable' ? 'Turn off' : 'Regenerate'}
              </button>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => { setAction(null); setCode(''); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={ghostBtn} onClick={() => { setError(null); setAction('regenerate'); }}>
              Regenerate recovery codes
            </button>
            {!status.required ? (
              <button type="button" className={ghostBtn} onClick={() => { setError(null); setAction('disable'); }}>
                Turn off two-factor
              </button>
            ) : null}
          </div>
        )
      ) : null}

      <button type="button" className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300" onClick={refreshStatus}>
        Refresh
      </button>
    </div>
  );
}
