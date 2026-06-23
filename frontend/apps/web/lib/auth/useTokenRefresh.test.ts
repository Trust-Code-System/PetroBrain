import { describe, expect, it } from 'vitest';

import { refreshDelayMs } from './useTokenRefresh';

// Build a minimal unsigned JWT carrying just an `exp` (seconds since epoch).
function tokenWithExp(expSeconds: number): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'HS256' })}.${b64url({ exp: expSeconds })}.sig`;
}

describe('refreshDelayMs', () => {
  const now = 1_000_000_000_000; // fixed "now" in ms

  it('returns null when there is no token', () => {
    expect(refreshDelayMs(null, now)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(refreshDelayMs('not-a-jwt', now)).toBeNull();
  });

  it('schedules ~60s before expiry', () => {
    // exp 5 minutes out -> refresh at exp - 60s => 240s from now.
    const token = tokenWithExp((now + 5 * 60_000) / 1000);
    expect(refreshDelayMs(token, now)).toBe(240_000);
  });

  it('returns 0 when the token is already within the skew window', () => {
    const token = tokenWithExp((now + 30_000) / 1000); // 30s left < 60s skew
    expect(refreshDelayMs(token, now)).toBe(0);
  });

  it('returns 0 for an already-expired token', () => {
    const token = tokenWithExp((now - 10_000) / 1000);
    expect(refreshDelayMs(token, now)).toBe(0);
  });

  it('caps the delay so a long TTL still re-evaluates within 10 minutes', () => {
    const token = tokenWithExp((now + 60 * 60_000) / 1000); // 1h out
    expect(refreshDelayMs(token, now)).toBe(10 * 60_000);
  });
});
