import type { Metadata, Viewport } from 'next';
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
    <html lang="en">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
