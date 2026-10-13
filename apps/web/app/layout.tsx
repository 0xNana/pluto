import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import '../components/shell/app-shell.css';
import '../components/researcher/researcher-workspace.css';
import '../components/landing/landing-page.css';

export const metadata: Metadata = {
  title: 'Pluto · Verifiable vulnerability disclosure',
  description: 'Private vulnerability reports, immutable release windows and independent public verification.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
