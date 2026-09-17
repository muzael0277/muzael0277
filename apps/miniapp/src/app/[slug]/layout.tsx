'use client';

import { ShopProvider } from '@/lib/shop';

export default function ShopLayout({
  children, params,
}: { children: React.ReactNode; params: { slug: string } }) {
  return <ShopProvider tenantSlug={params.slug}>{children}</ShopProvider>;
}
