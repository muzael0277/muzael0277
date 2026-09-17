import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BizBot OS — Telegram’da biznesingiz uchun raqamli filial',
  description:
    'Savdo, bron, buyurtma, mijozlar, to‘lovlar va biznes boshqaruvi — barchasi bitta platformada. Telegram bot va Mini App bilan.',
  keywords: ['telegram bot', 'biznes', 'CRM', 'onlayn do‘kon', 'bron', 'O‘zbekiston'],
  openGraph: {
    title: 'BizBot OS',
    description: 'Telegram’da biznesingiz uchun raqamli filial',
    locale: 'uz_UZ',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <body className="antialiased">{children}</body>
    </html>
  );
}
