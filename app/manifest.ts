import type { MetadataRoute } from 'next';

/**
 * Installable on a ward phone or tablet (IPD plan §T1.8): opens full screen,
 * straight onto the ward grid, like an app. Staff at the desk keep using the
 * browser; this only matters to the device a nurse carries.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Qurio Ward',
    short_name: 'Qurio Ward',
    description: 'Record medicines and items at the bedside.',
    start_url: '/ipd/ward',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f1f5f9',
    theme_color: '#0d9488',
    icons: [
      { src: '/icons/qurio-ward.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/qurio-ward.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
