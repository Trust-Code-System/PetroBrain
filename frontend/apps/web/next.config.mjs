// Static security headers applied to every response. The Content-Security-Policy
// is NOT here: it carries a per-request nonce for script-src (so Next's injected
// inline bootstrap scripts and our theme script run under a strict policy without
// 'unsafe-inline'), so it is set dynamically in middleware.ts instead.
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
  // Transpile the workspace TS packages directly - they ship .ts at runtime.
  transpilePackages: ['@petrobrain/ui', '@petrobrain/api', '@petrobrain/types'],
  experimental: {
    typedRoutes: true,
  },
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
