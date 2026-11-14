import type { Metadata } from 'next';
import PrivacyPage, { metadata as baseMetadata } from '../privacy/page';

export const metadata: Metadata = {
  ...baseMetadata,
  alternates: {
    canonical: '/privacy',
  },
  robots: {
    index: false,
    follow: true,
  },
};

export default PrivacyPage;
