import type { MetadataRoute } from 'next';

const BASE_URL = 'https://hospital-automation-sepia.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/pricing',
          '/privacy',
          '/_next/static/',
          '/_next/image/',
          '/icons/',
          '/favicon.ico',
        ],
        disallow: [
          '/api/',
          '/dashboard',
          '/account',
          '/accountability',
          '/admin',
          '/audit',
          '/ipd',
          '/reports',
          '/settings',
          '/subscription',
          '/tests',
          '/whatsapp-notices',
          '/login',
          '/ward-device',
          '/unlock',
          '/change-password',
          '/display/',
          '/q/',
          '/b/',
          '/book',
          '/print/',
          '/plan-inactive',
          '/plans',
          '/notice',
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}

