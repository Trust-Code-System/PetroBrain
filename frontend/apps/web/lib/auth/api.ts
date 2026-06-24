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

async function postAuth(
  baseUrl: string,
  path: '/auth/signup' | '/auth/signin',
  body: { email: string; password: string; account_type?: 'individual' | 'company'; full_name?: string },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (res.ok) {
    return (await res.json()) as AuthResponse;
  }

  // Pull a friendlier message off `{detail: "..."}` when the backend supplied
  // one, fall back to the HTTP status otherwise.
  let detail = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as AuthErrorBody;
    if (data && typeof data.detail === 'string') detail = data.detail;
  } catch {
    // Body wasn't JSON; keep the status-line fallback.
  }
  throw new AuthError(detail, res.status);
}

export function signup(
  baseUrl: string,
  body: { email: string; password: string; account_type?: 'individual' | 'company'; full_name?: string },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  return postAuth(baseUrl, '/auth/signup', body, signal);
}

export function signin(
  baseUrl: string,
  body: { email: string; password: string },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  return postAuth(baseUrl, '/auth/signin', body, signal);
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
