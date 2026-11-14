import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Devanagari } from 'next/font/google';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

/**
 * Marathi and Hindi are first-class here, not an afterthought, so the
 * Devanagari face ships with the app rather than falling back to whatever a
 * budget Android happens to have installed.
 */
const devanagari = Noto_Sans_Devanagari({
  variable: '--font-deva',
  subsets: ['devanagari'],
  display: 'swap',
});

const BASE_URL = 'https://hospital-automation-sepia.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    template: '%s · QuriioHQ',
    default: 'QuriioHQ — Hospital Queue Management System & OPD Automation India',
  },
  description:
    'Transform chaotic waiting rooms into an orderly digital queue. QuriioHQ provides WhatsApp appointment booking, live queue tracker links, smart TV display boards, and 1-touch reception calling for Indian clinics and hospitals.',
  keywords: [
    'Hospital Queue Management System',
    'OPD Management Software',
    'Patient Queue Management System India',
    'Clinic Management Software India',
    'WhatsApp Appointment Booking Software',
    'Hospital Automation Software',
    'Doctor Appointment Management Software',
    'Patient Token Display System',
    'Hospital Waiting Room Display Software',
    'IPD Management Software India',
    'OPD Queue Management Software Maharashtra',
  ],
  authors: [{ name: 'QuriioHQ', url: BASE_URL }],
  creator: 'QuriioHQ',
  publisher: 'QuriioHQ',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_IN',
    alternateLocale: ['mr_IN', 'hi_IN'],
    url: BASE_URL,
    siteName: 'QuriioHQ',
    title: 'QuriioHQ — Hospital Queue Management System & OPD Automation India',
    description:
      'Empty crowded hospital corridors with QuriioHQ. Smart OPD queue management, WhatsApp appointment booking, waiting-room TV displays, and 1-click reception calling.',
    images: [
      {
        url: '/icons/qurio-ward.svg',
        width: 512,
        height: 512,
        alt: 'QuriioHQ OPD Queue Management System',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'QuriioHQ — Hospital Queue Management System & OPD Automation India',
    description:
      'Empty crowded hospital corridors with QuriioHQ. Smart OPD queue management, WhatsApp appointment booking, and live queue tracking.',
    images: ['/icons/qurio-ward.svg'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f766e',
};

const jsonLd = [
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'QuriioHQ',
    url: BASE_URL,
    logo: `${BASE_URL}/icons/qurio-ward.svg`,
    description:
      'Healthcare SaaS provider specializing in OPD queue management, WhatsApp patient flow automation, and hospital operations software in India.',
    email: 'omdhangar24@gmail.com',
    areaServed: {
      '@type': 'Country',
      name: 'India',
    },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'QuriioHQ',
    url: BASE_URL,
    inLanguage: ['en', 'mr', 'hi'],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'QuriioHQ',
    operatingSystem: 'All modern web browsers, Android, iOS',
    applicationCategory: 'HealthApplication, BusinessApplication',
    description:
      'OPD queue management system and hospital automation platform for Indian clinics and hospitals. Features WhatsApp appointment booking, live waiting room TV displays, digital tokens, and nurse bedside IPD records.',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'INR',
      lowPrice: '1999',
      highPrice: '12999',
      offerCount: '6',
    },
  },
];

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${devanagari.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
