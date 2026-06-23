'use client';

import { useEffect, useRef } from 'react';

import { useChatStore } from '@/lib/chat/store';
import { tokenExpiryMs } from '@/lib/chat/jwt';
import { refreshSession, AuthError } from './api';

// Refresh this long before the access token actually expires so a slow network
// round-trip still lands a fresh token before the old one dies.
const REFRESH_SKEW_MS = 60_000;
// Never schedule further out than this, so a clock skew or an unusually long TTL
// can't park the timer for hours; we re-evaluate at least this often.
const MAX_DELAY_MS = 10 * 60_000;

/**
 * Pure scheduler: how long to wait before refreshing, given the access token and
 * the current time. Returns null when there is no usable expiry (caller should
 * not schedule). Clamped to [0, MAX_DELAY_MS]; an already-expired or
 * about-to-expire token yields 0 (refresh now).
 */
export function refreshDelayMs(token: string | null, nowMs: number): number | null {
  const expMs = tokenExpiryMs(token);
  if (expMs === null) return null;
  const target = expMs - REFRESH_SKEW_MS - nowMs;
  if (target <= 0) return 0;
  return Math.min(target, MAX_DELAY_MS);
}

/**
 * Proactively exchange the refresh token for a new access+refresh pair shortly
 * before the access token expires, so the user keeps a valid session without
 * re-authenticating. Mounted once near the top of the tree (Providers). No-ops
 * when signed out. On a hard refresh failure (401) it expires the session so the
 * existing signin-redirect flow takes over.
 */
export function useTokenRefresh(): void {
  const token = useChatStore((s) => s.token);
  const refreshToken = useChatStore((s) => s.refreshToken);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!token || !refreshToken) return;
    const delay = refreshDelayMs(token, Date.now());
    if (delay === null) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await refreshSession(apiBaseUrl, refreshToken);
        if (cancelled) return;
        useChatStore.getState().setSession(res.token, res.refresh_token, {
          ...res.principal,
          email: res.principal.email,
        });
      } catch (err) {
        if (cancelled) return;
        // A 401 means the refresh token is spent/invalid -> end the session.
        // Transient/network errors leave the session as-is; the next effect run
        // (or a real request's own 401 handling) will retry.
        if (err instanceof AuthError && err.status === 401) {
          useChatStore.getState().expireSession('expired');
        }
      } finally {
        inFlight.current = false;
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Re-run whenever the token rotates (new exp) or sign-in/out changes tokens.
  }, [token, refreshToken, apiBaseUrl]);
}
