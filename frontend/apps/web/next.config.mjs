/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
