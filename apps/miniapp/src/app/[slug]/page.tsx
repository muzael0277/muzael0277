'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { Button, Card, EmptyState, Skeleton, Spinner } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { useShop, shopApi, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';

interface CatalogResponse {
  categories: { id: string; name: string; imageUrl: string | null }[];
  products: {
    id: string;
    name: string;
    price: number;
    oldPrice: number | null;
    image: string | null;
    isFeatured: boolean;
    isAvailable: boolean;
  }[];
}

export default function HomePage({ params }: { params: { slug: string } }) {
  const { ready, error, data, preview, hasModule } = useShop();

  const { data: catalog } = useSWR<CatalogResponse>(
    data && hasModule('CATALOG') ? '/catalog' : null,
    shopFetcher,
  );

  const { data: services } = useSWR<
    { id: string; name: string; price: number; durationMinutes: number }[]
  >(data && hasModule('SERVICES') ? '/services' : null, shopFetcher);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  if (preview) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <EmptyState
          title="Telegram orqali oching"
          description="Bu ilova biznesning Telegram boti ichida ishlaydi. Botni oching va “Ilovani ochish” tugmasini bosing."
        />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <EmptyState title="Ulanib bo‘lmadi" description={error ?? undefined} />
      </div>
    );
  }

  const { tenant, customer } = data;
  const money = (value: number) => formatMoney(value, tenant.currency as never, customer.language);
  const featured = catalog?.products.filter((p) => p.isFeatured).slice(0, 6) ?? [];

  return (
    <div className="pb-4">
      {/* Business header — the customer should feel they are in this shop, not a platform. */}
      <header className="bg-brand px-4 pb-6 pt-5 text-brand-fg">
        <div className="flex items-center gap-3">
          {tenant.logoUrl ? (
            <img src={tenant.logoUrl} alt="" className="h-11 w-11 rounded-xl object-cover" />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 text-lg font-bold">
              {tenant.name.charAt(0)}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{tenant.name}</h1>
            {tenant.description && (
              <p className="truncate text-sm opacity-80">{tenant.description}</p>
            )}
          </div>
        </div>

        {tenant.loyalty?.enabled && (
          <div className="mt-4 flex items-center justify-between rounded-xl bg-white/15 px-4 py-3 backdrop-blur">
            <span className="text-sm opacity-90">Bonuslaringiz</span>
            <span className="font-semibold tabular">{money(customer.loyaltyBalance)}</span>
          </div>
        )}
      </header>

      <div className="-mt-3 space-y-4 rounded-t-2xl bg-surface-sunken px-4 pt-5">
        {hasModule('BOOKING') && (
          <Link href={`/${params.slug}/services`} className="block">
            <Card className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">Onlayn navbatga yozilish</p>
                <p className="mt-0.5 text-sm text-content-muted">Bo‘sh vaqtni tanlang</p>
              </div>
              <span className="text-brand" aria-hidden>
                →
              </span>
            </Card>
          </Link>
        )}

        {catalog && catalog.categories.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-content-muted">Kategoriyalar</h2>
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {catalog.categories.map((category) => (
                <Link
                  key={category.id}
                  href={`/${params.slug}/catalog?category=${category.id}`}
                  className="tap shrink-0 rounded-xl border border-line bg-surface-raised px-4 py-2.5 text-sm"
                >
                  {category.name}
                </Link>
              ))}
            </div>
          </section>
        )}

        {featured.length > 0 && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-content-muted">Tavsiya etamiz</h2>
              <Link href={`/${params.slug}/catalog`} className="text-sm text-brand">
                Barchasi
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {featured.map((product) => (
                <Link key={product.id} href={`/${params.slug}/catalog/${product.id}`}>
                  <Card className="overflow-hidden">
                    <div className="aspect-square bg-surface-sunken">
                      {product.image && (
                        <img src={product.image} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="line-clamp-2 text-sm">{product.name}</p>
                      <p className="mt-1 font-semibold tabular">{money(product.price)}</p>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {services && services.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-content-muted">Xizmatlar</h2>
            <div className="space-y-2">
              {services.slice(0, 5).map((service) => (
                <Link key={service.id} href={`/${params.slug}/services?service=${service.id}`}>
                  <Card className="flex items-center justify-between p-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{service.name}</p>
                      <p className="text-xs text-content-subtle">
                        {service.durationMinutes} daqiqa
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold tabular">{money(service.price)}</span>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {!catalog && !services && (
          <div className="space-y-3 py-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        )}
      </div>

      <BottomNav slug={params.slug} />
    </div>
  );
}
