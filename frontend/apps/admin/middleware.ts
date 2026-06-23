import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce. See apps/web/middleware.ts
 * for the full rationale. Next.js stamps the nonce onto the inline bootstrap
 * scripts it injects; the admin app has no developer-authored inline scripts, so
 * no layout change is needed here.
 */
function apiOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL || '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const connectSrc = ["'self'", apiOrigin()].filter(Boolean).join(' ');

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
