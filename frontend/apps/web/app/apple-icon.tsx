import { ImageResponse } from 'next/og';

// iOS ignores the web manifest icons and uses the apple-touch-icon, so we
// generate a real PNG here. Built once at compile time; rendered with satori,
// hence a flex div + brand gradient rather than the SVG droplet path.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
// Render on demand rather than at build time: prerendering this route under
// the app's strict CSP/middleware tripped an "Invalid URL" in next/og. The
// icon is tiny and cached, so on-demand generation is a non-issue.
export const dynamic = 'force-dynamic';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #fb923c 0%, #ea580c 55%, #7c2d12 100%)',
          color: '#ffffff',
          fontSize: 108,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          fontFamily: 'sans-serif',
        }}
      >
        P
      </div>
    ),
    { ...size },
  );
}
