import type { Metadata, Viewport } from 'next';
// Self-hosted (next/font/local inside the geist package): bundled at build time, no network.
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { SessionProvider } from '@/components/providers/session-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: 'XiaoMei ERP',
  description: 'Orders, stock and payments for XiaoMei Printshop',
};

// Tablets on the shop Wi-Fi (Q4): no pinch-zoom lock, fit the device width.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. Grammarly) add attributes to <html> and
    // <body> before React hydrates. It only silences attribute differences on these two
    // elements, not in the page content.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased" suppressHydrationWarning>
        <SessionProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
