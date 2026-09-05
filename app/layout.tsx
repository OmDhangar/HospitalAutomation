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

export const metadata: Metadata = {
  title: 'OPD Queue',
  description: 'Live OPD queue and patient flow',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f766e',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${devanagari.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
