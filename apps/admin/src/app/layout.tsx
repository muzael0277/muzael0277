import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@bizbot/ui';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'BizBot OS',
  description: 'Telegram’da biznesingiz uchun raqamli filial',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The dashboard is desktop-first but must stay usable on a phone, so pinch-zoom is
  // left enabled rather than locked off.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <body className="min-h-screen antialiased">
        <ToastProvider>
          <SessionProvider>{children}</SessionProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
