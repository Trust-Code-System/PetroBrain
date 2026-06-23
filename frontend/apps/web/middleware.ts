import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce.
 *
 * script-src uses a fresh nonce instead of 'unsafe-inline'. Next.js detects the
 * nonce in the request's CSP header and automatically stamps it onto the inline
 * bootstrap scripts it injects; our own inline theme script reads the same nonce
 * from headers() in app/layout.tsx. 'strict-dynamic' lets those trusted scripts
 * load their bundled children without us enumerating every hashed chunk.
 *
 * connect-src is pinned to 'self' plus the API origin so XHR/fetch can only reach
 * the backend the app is built against. style-src keeps 'unsafe-inline' for
 * Tailwind's small inline style blocks (a nonce-based style rewrite is a Phase-2
 * follow-up, matching the API CSP's own note).
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
    'object-src \'none\'',
  ].join('; ');

  // Forward the nonce to the app via a request header so layout.tsx can read it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Run on document requests only. Skip Next's static assets, image optimizer,
  // and the favicon so we don't put a (dynamic) CSP on cacheable static files.
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
