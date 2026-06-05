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
  principal: AuthPrincipalPayload;
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
  body: { email: string; password: string },
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
  body: { email: string; password: string },
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
