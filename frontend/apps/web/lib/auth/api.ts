import type { Role } from '@petrobrain/types';

/**
 * /auth/signin and /auth/signup wire-format client. The backend returns
 * `{token, principal}` on success; the token is what every other route's
 * Authorization header carries afterwards.
 */
export interface AuthPrincipalPayload {
  user_id: string;
  tenant_id: string;
  role: Role;
  email: string;
  allowed_assets: string[];
}

export interface AuthResponse {
  token: string;
  // Long-lived, single-use. Exchanged at /auth/refresh for a new access token
  // (and a new refresh token) when the short-lived access token nears expiry.
  refresh_token: string;
  principal: AuthPrincipalPayload;
  onboarding_required?: boolean;
  // Present only on the response that completes 2FA enrollment - the one-time
  // recovery codes, shown to the user once.
  recovery_codes?: string[] | null;
}

/**
 * Returned by /auth/signin and /auth/signup when a second factor is required.
 * No session is issued yet; the client enrols (if needed) then posts a code to
 * /auth/2fa/verify to exchange `mfa_token` for a real AuthResponse.
 */
export interface MfaChallenge {
  mfa_required: true;
  enrolled: boolean;
  mfa_token: string;
}

export interface MfaEnrollData {
  secret: string;
  otpauth_uri: string;
  issuer: string;
  account: string;
}

export type AuthResult = AuthResponse | MfaChallenge;

export function isMfaChallenge(result: AuthResult): result is MfaChallenge {
  return (result as MfaChallenge).mfa_required === true;
}

export interface AuthErrorBody {
  detail?: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'AuthError';
  }
}

/** Pull `{detail}` off an error body, falling back to the status line. */
async function errorDetail(res: Response): Promise<string> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as AuthErrorBody;
    if (data && typeof data.detail === 'string') detail = data.detail;
  } catch {
    // Body wasn't JSON; keep the status-line fallback.
  }
  return detail;
}

async function postAuth(
  baseUrl: string,
  path: '/auth/signup' | '/auth/signin',
  body: { email: string; password: string; account_type?: 'individual' | 'company'; full_name?: string },
  signal?: AbortSignal,
): Promise<AuthResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (res.ok) {
    // Either a full session or a 2FA challenge - the caller disambiguates.
    return (await res.json()) as AuthResult;
  }
  throw new AuthError(await errorDetail(res), res.status);
}

export function signup(
  baseUrl: string,
  body: { email: string; password: string; account_type?: 'individual' | 'company'; full_name?: string },
  signal?: AbortSignal,
): Promise<AuthResult> {
  return postAuth(baseUrl, '/auth/signup', body, signal);
}

export function signin(
  baseUrl: string,
  body: { email: string; password: string },
  signal?: AbortSignal,
): Promise<AuthResult> {
  return postAuth(baseUrl, '/auth/signin', body, signal);
}

/**
 * Begin TOTP enrollment using a challenge token from signin/signup. Returns the
 * authenticator secret + otpauth URI; the user then proves a code via verify2fa.
 */
export async function enroll2fa(
  baseUrl: string,
  mfaToken: string,
  signal?: AbortSignal,
): Promise<MfaEnrollData> {
  const res = await fetch(`${baseUrl}/auth/2fa/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mfa_token: mfaToken }),
    ...(signal ? { signal } : {}),
  });
  if (res.ok) return (await res.json()) as MfaEnrollData;
  throw new AuthError(await errorDetail(res), res.status);
}

/**
 * Complete sign-in (or enrollment) by submitting a 6-digit code or a recovery
 * code with the challenge token. Returns the real session on success.
 */
export async function verify2fa(
  baseUrl: string,
  body: { mfa_token: string; code: string },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (res.ok) return (await res.json()) as AuthResponse;
  throw new AuthError(await errorDetail(res), res.status);
}

/**
 * Kick off a password reset for an email. The backend is enumeration-safe and
 * always answers 200 with a neutral message, so this resolves with that message
 * regardless of whether the email maps to an account. Only network/5xx faults
 * throw, so the UI can show one neutral confirmation in the success path.
 */
export async function requestPasswordReset(
  baseUrl: string,
  email: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    ...(signal ? { signal } : {}),
  });
  if (res.ok) {
    try {
      const data = (await res.json()) as { message?: string };
      if (data && typeof data.message === 'string') return data.message;
    } catch {
      // Non-JSON 200; fall through to the generic confirmation.
    }
    return 'If that email belongs to an account, a reset link is on its way.';
  }
  let detail = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as AuthErrorBody;
    if (data && typeof data.detail === 'string') detail = data.detail;
  } catch {
    // non-JSON body; keep the status-line fallback
  }
  throw new AuthError(detail, res.status);
}

/**
 * Complete a password reset with the emailed token and a new password. On
 * success the backend signs the user straight in, returning the same
 * `{token, refresh_token, principal}` shape as signin. Throws AuthError on an
 * invalid/expired token (400) or a too-weak password (422).
 */
export async function resetPassword(
  baseUrl: string,
  body: { token: string; password: string },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (res.ok) {
    return (await res.json()) as AuthResponse;
  }
  let detail = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as AuthErrorBody;
    if (data && typeof data.detail === 'string') detail = data.detail;
  } catch {
    // non-JSON body; keep the status-line fallback
  }
  throw new AuthError(detail, res.status);
}

export interface MfaStatus {
  enabled: boolean;
  required: boolean;
}

/** Authenticated POST helper for the logged-in 2FA management endpoints. */
async function authedPost(
  baseUrl: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.ok) return res.json();
  throw new AuthError(await errorDetail(res), res.status);
}

export async function get2faStatus(baseUrl: string, token: string): Promise<MfaStatus> {
  const res = await fetch(`${baseUrl}/auth/2fa/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return (await res.json()) as MfaStatus;
  throw new AuthError(await errorDetail(res), res.status);
}

/** Begin enrollment from Settings (session-authenticated, no challenge token). */
export function setup2fa(baseUrl: string, token: string): Promise<MfaEnrollData> {
  return authedPost(baseUrl, '/auth/2fa/setup', token) as Promise<MfaEnrollData>;
}

export function activate2fa(
  baseUrl: string,
  token: string,
  code: string,
): Promise<{ recovery_codes: string[] }> {
  return authedPost(baseUrl, '/auth/2fa/activate', token, { code }) as Promise<{
    recovery_codes: string[];
  }>;
}

export function disable2fa(baseUrl: string, token: string, code: string): Promise<MfaStatus> {
  return authedPost(baseUrl, '/auth/2fa/disable', token, { code }) as Promise<MfaStatus>;
}

export function regenerateRecoveryCodes(
  baseUrl: string,
  token: string,
  code: string,
): Promise<{ recovery_codes: string[] }> {
  return authedPost(baseUrl, '/auth/2fa/recovery-codes', token, { code }) as Promise<{
    recovery_codes: string[];
  }>;
}

/**
 * Exchange a refresh token for a fresh access + refresh pair. Throws AuthError
 * on a 401 (token used/expired/revoked) so the caller can drop the session and
 * route the user to sign in.
 */
export async function refreshSession(
  baseUrl: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    ...(signal ? { signal } : {}),
  });
  if (res.ok) {
    return (await res.json()) as AuthResponse;
  }
  let detail = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as AuthErrorBody;
    if (data && typeof data.detail === 'string') detail = data.detail;
  } catch {
    // non-JSON body; keep the status-line fallback
  }
  throw new AuthError(detail, res.status);
}
