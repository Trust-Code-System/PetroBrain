// Static security headers. The nonce-bearing Content-Security-Policy is set
// per-request in middleware.ts (see that file for the rationale).
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  transpilePackages: ['@petrobrain/ui', '@petrobrain/api', '@petrobrain/types'],
  experimental: { typedRoutes: true },
  // The workspace TS packages use ESM-style `.js` import specifiers that point
  // at `.ts`/`.tsx` sources (NodeNext convention). tsc and Vitest resolve these,
  // but Next's production webpack build needs the extension alias to follow them.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
