import type { Principal, Role } from '@petrobrain/types';

/**
 * Decode-only JWT inspection. Signature verification happens server-side on
 * every request; the client just needs to surface tenant + role + assets in
 * the sidebar. Returns ``null`` for malformed tokens.
 */
export function decodePrincipal(token: string | null): Principal | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]!));
    if (typeof payload !== 'object' || payload === null) return null;
    const tenantId = stringClaim(payload, 'tenant_id');
    const userId = stringClaim(payload, 'user_id') ?? stringClaim(payload, 'sub');
    const email = stringClaim(payload, 'email');
    const role = stringClaim(payload, 'role');
    const allowed = (payload as Record<string, unknown>).allowed_assets;
    if (!tenantId || !userId || !isRole(role)) return null;
    return {
      tenantId,
      userId,
      ...(email ? { email } : {}),
      role,
      allowedAssets: Array.isArray(allowed) ? allowed.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return null;
  }
}

function stringClaim(obj: unknown, key: string): string | null {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isRole(value: string | null): value is Role {
  return (
    value === 'platform_admin'
    || value === 'admin'
    || value === 'engineer'
    || value === 'field'
    || value === 'hse'
  );
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  if (typeof atob === 'function') return atob(padded);
  // Node test runtime fallback (happy-dom polyfills atob, but be defensive)
  return Buffer.from(padded, 'base64').toString('binary');
}
