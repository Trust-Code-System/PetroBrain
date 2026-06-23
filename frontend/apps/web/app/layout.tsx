import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Inter } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';

import { ThemeApplier, THEME_INIT_SCRIPT } from '@/lib/chat/theme';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  // Base for resolving metadata-relative URLs (OG images, generated icons) at
  // build time. Set NEXT_PUBLIC_SITE_URL in deploys; localhost is the dev/CI
  // fallback so prerendering the generated apple-icon never sees an invalid URL.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'PetroBrain - Office',
  description: 'PetroBrain office surface for engineering and control-room staff.',
  robots: { index: false, follow: false },
  // Lets iOS launch the installed app full-screen (no Safari chrome) when
  // added to the home screen, matching the standalone display in manifest.ts.
  appleWebApp: {
    capable: true,
    title: 'PetroBrain',
    statusBarStyle: 'default',
  },
  openGraph: {
    title: 'PetroBrain - Office',
    description: 'PetroBrain office surface for engineering and control-room staff.',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Let the app paint into the notch / home-bar area; the shell then pads
  // itself back out with env(safe-area-inset-*) so nothing is clipped.
  viewportFit: 'cover' as const,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Nonce minted per request in middleware.ts; used so the pre-hydration theme
  // script runs under the strict (no 'unsafe-inline') script-src CSP.
  const nonce = headers().get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-white font-sans text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <ThemeApplier />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
