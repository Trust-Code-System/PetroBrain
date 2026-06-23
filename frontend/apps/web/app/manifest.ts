import type { MetadataRoute } from 'next';

/**
 * Web app manifest so PetroBrain installs to the home screen and launches
 * full-screen (no browser chrome), the way the Claude/ChatGPT mobile apps do.
 * Next serves this at /manifest.webmanifest and links it automatically.
 *
 * start_url points at /chat: an installed launch should drop the user straight
 * into the conversation surface, not the marketing root.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PetroBrain',
    short_name: 'PetroBrain',
    description: 'PetroBrain operations copilot for engineering and control-room staff.',
    start_url: '/chat',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      // /icon.svg is served by Next from app/icon.svg.
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
