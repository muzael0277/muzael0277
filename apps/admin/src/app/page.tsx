'use client';

import * as React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, Sparkline, StatCard } from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { fetcher } from '@/lib/api';
import { money, relative, ORDER_STATUS_TONE } from '@/lib/format';

interface Dashboard {
  revenue: { value: number; previous: number; changePercent: number };
  orders: { value: number; previous: number; changePercent: number };
  bookings: { value: number; previous: number; changePercent: number };
  customers: { total: number; new: number; returning: number };
  averageOrderValue: number;
  ordersByStatus: { status: string; count: number }[];
  topProducts: { id: string; name: string; quantity: number; revenue: number }[];
  topServices: { id: string; name: string; count: number; revenue: number }[];
  revenueTimeline: { date: string; revenue: number; orders: number }[];
  lowStock: { id: string; name: string; stockQuantity: number; threshold: number }[];
}

interface Insight {
  key: string;
  severity: 'info' | 'warning' | 'critical' | 'positive';
  title: { uz: string; ru: string };
  body: { uz: string; ru: string };
}

const RANGES = [
  { key: 'today', labelKey: 'common.today' },
  { key: 'last7', labelKey: 'common.week' },
  { key: 'last30', labelKey: 'common.month' },
] as const;

export default function DashboardPage() {
  const { tenant, language, hasModule, can } = useSession();
  const [range, setRange] = React.useState<'today' | 'last7' | 'last30'>('last30');

  const { data, error, isLoading, mutate } = useSWR<Dashboard>(
    tenant && can('analytics:read') ? [`/t/${tenant.id}/analytics/dashboard?preset=${range}`, tenant.id] : null,
    fetcher,
  );

  const { data: insights } = useSWR<Insight[]>(
    tenant && can('analytics:read') ? [`/t/${tenant.id}/analytics/insights`, tenant.id] : null,
    fetcher,
  );

  const { data: recentOrders } = useSWR<{ data: OrderRow[] }>(
    tenant && hasModule('ORDERS') && can('order:read')
      ? [`/t/${tenant.id}/orders?pageSize=6`, tenant.id]
      : null,
    fetcher,
  );

  const currency = tenant?.slug ? 'UZS' : 'UZS';

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.dashboard')}
        description={tenant?.name}
        action={
          <div className="flex gap-1 rounded-lg border border-line bg-surface-raised p-1">
            {RANGES.map((option) => (
              <button
                key={option.key}
                onClick={() => setRange(option.key)}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  range === option.key ? 'bg-brand-subtle font-medium text-brand' : 'text-content-muted hover:text-content'
                }`}
              >
                {t(language, option.labelKey)}
              </button>
            ))}
          </div>
        }
      />

      {error ? (
        <Card><ErrorState message={t(language, 'errors.INTERNAL')} onRetry={() => void mutate()} /></Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Daromad"
              value={money(data?.revenue.value ?? 0, currency, language)}
              change={data?.revenue.changePercent}
              loading={isLoading}
            />
            <StatCard
              label={t(language, 'nav.orders')}
              value={data?.orders.value ?? 0}
              change={data?.orders.changePercent}
              loading={isLoading}
            />
            {hasModule('BOOKING') && (
              <StatCard
                label={t(language, 'nav.bookings')}
                value={data?.bookings.value ?? 0}
                change={data?.bookings.changePercent}
                loading={isLoading}
              />
            )}
            <StatCard
              label="O‘rtacha chek"
              value={money(data?.averageOrderValue ?? 0, currency, language)}
              loading={isLoading}
            />
          </div>

          {/* Insights are derived from the numbers above, so an owner can always check
              them against the same dashboard rather than taking them on faith. */}
          {insights && insights.length > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {insights.map((insight) => (
                <div
                  key={insight.key}
                  className={`rounded-lg border-l-4 bg-surface-raised p-4 shadow-card ${
                    insight.severity === 'critical' ? 'border-l-critical'
                    : insight.severity === 'warning' ? 'border-l-warning'
                    : insight.severity === 'positive' ? 'border-l-positive'
                    : 'border-l-info'
                  }`}
                >
                  <p className="text-sm font-medium text-content">
                    {language === 'ru' ? insight.title.ru : insight.title.uz}
                  </p>
                  <p className="mt-1 text-sm text-content-muted">
                    {language === 'ru' ? insight.body.ru : insight.body.uz}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Daromad dinamikasi" />
              <div className="p-5">
                {data && data.revenueTimeline.length > 1 ? (
                  <>
                    <Sparkline points={data.revenueTimeline.map((d) => d.revenue)} height={120} />
                    <div className="mt-2 flex justify-between text-xs text-content-subtle tabular">
                      <span>{data.revenueTimeline[0]?.date}</span>
                      <span>{data.revenueTimeline.at(-1)?.date}</span>
                    </div>
                  </>
                ) : (
                  <p className="py-10 text-center text-sm text-content-subtle">
                    Ma’lumot yetarli emas
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Mijozlar" />
              <div className="space-y-3 p-5">
                {[
                  ['Jami', data?.customers.total],
                  ['Yangi', data?.customers.new],
                  ['Qaytgan', data?.customers.returning],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between">
                    <span className="text-sm text-content-muted">{label}</span>
                    <span className="font-medium tabular">{value ?? '—'}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {data && data.lowStock.length > 0 && (
            <Card className="mt-4 border-warning/30">
              <CardHeader
                title="Ombor tugayapti"
                description={`${data.lowStock.length} ta mahsulot`}
                action={<Link href="/products?lowStock=true"><Button variant="secondary" size="sm">Ko‘rish</Button></Link>}
              />
              <div className="divide-y divide-line">
                {data.lowStock.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center justify-between px-5 py-3">
                    <span className="text-sm">{item.name}</span>
                    <Badge tone="warning">{item.stockQuantity} / {item.threshold}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {hasModule('ORDERS') && can('order:read') && (
            <Card className="mt-4">
              <CardHeader
                title="So‘nggi buyurtmalar"
                action={<Link href="/orders"><Button variant="ghost" size="sm">Barchasi →</Button></Link>}
              />
              <DataTable
                rows={recentOrders?.data ?? []}
                rowKey={(row) => row.id}
                loading={!recentOrders}
                empty={<EmptyState title={t(language, 'empty.orders')} />}
                columns={[
                  {
                    key: 'number', header: t(language, 'order.number'),
                    render: (row) => <span className="font-medium tabular">{row.orderNumber}</span>,
                  },
                  {
                    key: 'customer', header: t(language, 'order.customer'), secondary: true,
                    render: (row) => row.customer ? `${row.customer.firstName} ${row.customer.lastName ?? ''}` : '—',
                  },
                  {
                    key: 'status', header: t(language, 'order.status'),
                    render: (row) => (
                      <Badge tone={ORDER_STATUS_TONE[row.status as keyof typeof ORDER_STATUS_TONE] ?? 'neutral'}>
                        {t(language, `order.statuses.${row.status}`)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'created', header: 'Vaqt', secondary: true,
                    render: (row) => <span className="text-content-muted">{relative(row.createdAt, language)}</span>,
                  },
                  {
                    key: 'total', header: t(language, 'order.total'), align: 'right',
                    render: (row) => money(row.total, currency, language),
                  },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </AppShell>
  );
}

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  createdAt: string;
  customer?: { firstName: string; lastName: string | null } | null;
}
