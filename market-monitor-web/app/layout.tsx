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
  title: 'Northstar — Portfolio & Market Monitor',
  description: 'A focused workspace for monitoring the market, personal investments, and decision notes.',
  openGraph: {
    title: 'Northstar — Portfolio & Market Monitor',
    description: 'Monitor your portfolio, live market context, watchlist, journal, and review alerts in one focused workspace.',
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
    title: 'Northstar — Portfolio & Market Monitor',
    description: 'A focused workspace for monitoring the market, personal investments, and decision notes.',
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
