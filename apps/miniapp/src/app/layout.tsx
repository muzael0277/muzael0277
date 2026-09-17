import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { ToastProvider } from '@bizbot/ui';
import './globals.css';

export const metadata: Metadata = { title: 'BizBot', description: 'Telegram Mini App' };

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Inside a Telegram webview the app should feel native, so zoom is pinned and the
  // viewport fits the notch.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <head>
        {/* beforeInteractive: window.Telegram must exist before any component reads it. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body className="min-h-screen bg-surface-sunken antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
