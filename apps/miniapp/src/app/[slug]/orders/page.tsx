'use client';

import useSWR from 'swr';
import { Badge, Card, EmptyState, Skeleton } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { t } from '@bizbot/i18n';
import { useShop, shopApi, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';

const TONE = {
  NEW: 'info', ACCEPTED: 'brand', PREPARING: 'warning', READY: 'positive',
  DELIVERING: 'brand', COMPLETED: 'positive', CANCELLED: 'critical',
} as const;

export default function OrdersPage({ params }: { params: { slug: string } }) {
  const { data: shop } = useShop();
  const { data, isLoading } = useSWR<{ data: Order[] }>(
    shop ? '/orders?pageSize=30' : null,
    shopFetcher,
    // A customer waiting on food refreshes obsessively; polling saves them the gesture.
    { refreshInterval: 15_000 },
  );

  const language = shop?.customer.language ?? 'uz';
  const money = (value: number) => formatMoney(value, (shop?.tenant.currency ?? 'UZS') as never, language);

  return (
    <div className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Buyurtmalarim</h1>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : !data || data.data.length === 0 ? (
        <EmptyState title={t(language, 'empty.orders')} />
      ) : (
        <div className="space-y-2">
          {data.data.map((order) => (
            <Card key={order.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium tabular">{order.orderNumber}</p>
                  <p className="mt-0.5 text-xs text-content-subtle">
                    {new Date(order.createdAt).toLocaleString('ru-RU', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
                <Badge tone={TONE[order.status as keyof typeof TONE] ?? 'neutral'}>
                  {t(language, `order.statuses.${order.status}`)}
                </Badge>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <span className="text-sm text-content-muted">
                  {t(language, `order.fulfillment.${order.fulfillmentType}`)}
                </span>
                <span className="font-semibold tabular">{money(order.total)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <BottomNav slug={params.slug} />
    </div>
  );
}

interface Order {
  id: string; orderNumber: string; status: string; fulfillmentType: string;
  total: number; createdAt: string;
}
