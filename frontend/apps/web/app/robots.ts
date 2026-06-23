import type { MetadataRoute } from 'next';

// PetroBrain's office surface is an authenticated internal tool, not a public
// site. Disallow all crawling at the site level (the per-page metadata also sets
// noindex). Next serves this at /robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  };
}
