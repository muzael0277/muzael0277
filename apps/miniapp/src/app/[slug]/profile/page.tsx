'use client';

import useSWR from 'swr';
import { Badge, Card, EmptyState, Skeleton } from '@bizbot/ui';
import { formatMoney, formatUzPhone } from '@bizbot/shared';
import { useShop, shopApi, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';

export default function ProfilePage({ params }: { params: { slug: string } }) {
  const { data: shop, hasModule } = useShop();

  const { data: loyalty } = useSWR<{
    account: { balance: number; lifetimeEarned: string };
    data: { id: string; type: string; amount: number; reason: string | null; createdAt: string }[];
  }>(
    shop && hasModule('LOYALTY') ? '/loyalty' : null,
    shopFetcher,
  );

  if (!shop) {
    return <div className="p-4"><Skeleton className="h-32" /><BottomNav slug={params.slug} /></div>;
  }

  const money = (value: number | string) =>
    formatMoney(Number(value), shop.tenant.currency as never, shop.customer.language);

  return (
    <div className="p-4">
      <Card className="p-5 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-subtle text-xl font-semibold text-brand">
          {shop.customer.firstName.charAt(0)}
        </div>
        <p className="mt-3 font-medium">
          {shop.customer.firstName} {shop.customer.lastName ?? ''}
        </p>
        {shop.customer.phone && (
          <p className="text-sm text-content-muted">{formatUzPhone(shop.customer.phone)}</p>
        )}
      </Card>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Card className="p-4 text-center">
          <p className="text-xs text-content-muted">Buyurtmalar</p>
          <p className="mt-1 text-xl font-semibold tabular">{shop.customer.orderCount}</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-xs text-content-muted">Bronlar</p>
          <p className="mt-1 text-xl font-semibold tabular">{shop.customer.bookingCount}</p>
        </Card>
      </div>

      {hasModule('LOYALTY') && (
        <Card className="mt-3 p-5">
          <p className="text-sm text-content-muted">Bonus balansi</p>
          <p className="mt-1 text-2xl font-semibold text-brand tabular">
            {money(shop.customer.loyaltyBalance)}
          </p>
          {shop.tenant.loyalty?.rate ? (
            <p className="mt-1 text-xs text-content-subtle">
              Har bir buyurtmadan {shop.tenant.loyalty.rate}% qaytadi
            </p>
          ) : null}

          {loyalty && loyalty.data.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-line pt-3">
              {loyalty.data.slice(0, 8).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-content-muted">{entry.reason ?? entry.type}</p>
                    <p className="text-xs text-content-subtle">
                      {new Date(entry.createdAt).toLocaleDateString('ru-RU')}
                    </p>
                  </div>
                  <span className={`shrink-0 tabular ${entry.amount > 0 ? 'text-positive' : 'text-content'}`}>
                    {entry.amount > 0 ? '+' : ''}{money(entry.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="mt-3 p-4">
        <p className="text-sm font-medium">{shop.tenant.name}</p>
        {shop.tenant.phone && (
          <a href={`tel:+${shop.tenant.phone}`} className="mt-1 block text-sm text-brand">
            {formatUzPhone(shop.tenant.phone)}
          </a>
        )}
      </Card>

      <BottomNav slug={params.slug} />
    </div>
  );
}
