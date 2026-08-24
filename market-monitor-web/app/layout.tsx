import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://northstar-market-monitor.omerportnoy.chatgpt.site'),
  title: 'Northstar — Accountable Stock Forecast Journal',
  description: 'Record measurable stock forecasts alongside your portfolio, market context, and completed-bar research.',
  openGraph: {
    title: 'Northstar — Accountable Stock Forecast Journal',
    description: 'Create measurable forecasts, preserve activation-time market evidence, and review them alongside your portfolio.',
    url: 'https://northstar-market-monitor.omerportnoy.chatgpt.site',
    siteName: 'Northstar',
    images: [{
      url: 'https://northstar-market-monitor.omerportnoy.chatgpt.site/og.png',
      width: 1729,
      height: 910,
      alt: 'Northstar — Portfolio & Market Monitor',
    }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Northstar — Accountable Stock Forecast Journal',
    description: 'Create measurable forecasts and preserve the evidence available when they were activated.',
    images: ['https://northstar-market-monitor.omerportnoy.chatgpt.site/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
