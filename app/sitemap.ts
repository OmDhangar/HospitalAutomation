import type { MetadataRoute } from 'next';

const BASE_URL = 'https://hospital-automation-sepia.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
  // Only public, canonical, and indexable marketing pages are included.
  // All private application routes (dashboard, ipd, admin, settings),
  // dynamic token trackers (/q/[token], /b/[token]), live waiting displays,
  // print routes, and parameter-dependent booking pages are strictly excluded.
  return [
    {
      url: BASE_URL,
      lastModified: new Date('2026-11-06T00:00:00.000Z'),
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: new Date('2026-11-06T00:00:00.000Z'),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: new Date('2026-09-16T00:00:00.000Z'),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];
}

