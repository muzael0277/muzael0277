'use client';

import * as React from 'react';
import useSWR from 'swr';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  Modal,
  Pagination,
  Select,
  Tabs,
  useToast,
} from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { api, ApiError, fetcher } from '@/lib/api';
import { money, dateTime, phone, relative, ORDER_STATUS_TONE } from '@/lib/format';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentType: string;
  total: number;
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  createdAt: string;
  phoneSnapshot: string | null;
  addressSnapshot: string | null;
  customerComment: string | null;
  customer?: {
    id: string;
    firstName: string;
    lastName: string | null;
    phone: string | null;
  } | null;
  branch?: { id: string; name: string } | null;
  items?: {
    id: string;
    nameSnapshot: Record<string, string>;
    quantity: number;
    unitPrice: number;
    total: number;
    modifiers: { id: string; nameSnapshot: Record<string, string>; price: number }[];
  }[];
  statusHistory?: {
    id: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: string;
    comment: string | null;
  }[];
}

const STATUS_FLOW = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'DELIVERING', 'COMPLETED'] as const;

export default function OrdersPage() {
  const { tenant, language, can } = useSession();
  const toast = useToast();

  const [status, setStatus] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [updating, setUpdating] = React.useState(false);

  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (status !== 'all') query.set('status', status);
  if (debounced) query.set('search', debounced);

  const { data, isLoading, mutate } = useSWR<{
    data: Order[];
    meta: { total: number; totalPages: number };
  }>(
    tenant ? [`/t/${tenant.id}/orders?${query}`, tenant.id] : null,
    // Open orders are what the kitchen watches, so this refreshes while the tab is open.
    fetcher,
    { refreshInterval: 20_000 },
  );

  const { data: detail, mutate: mutateDetail } = useSWR<Order>(
    tenant && selected ? [`/t/${tenant.id}/orders/${selected}`, tenant.id] : null,
    fetcher,
  );

  async function changeStatus(orderId: string, next: string) {
    setUpdating(true);
    try {
      await api(`/t/${tenant!.id}/orders/${orderId}/status`, {
        method: 'PATCH',
        body: { status: next },
        tenantId: tenant!.id,
      });
      toast.success(`Holat: ${t(language, `order.statuses.${next}`)}`);
      await Promise.all([mutate(), mutateDetail()]);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t(language, 'errors.INTERNAL'));
    } finally {
      setUpdating(false);
    }
  }

  /** The next status in the pipeline, which is what staff need 90% of the time. */
  function nextStatus(current: string): string | null {
    const index = STATUS_FLOW.indexOf(current as (typeof STATUS_FLOW)[number]);
    if (index < 0 || index >= STATUS_FLOW.length - 1) return null;
    return STATUS_FLOW[index + 1] ?? null;
  }

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.orders')}
        description={data ? `${data.meta.total} ta buyurtma` : undefined}
      />

      <Card>
        <Tabs
          active={status}
          onChange={(key) => {
            setStatus(key);
            setPage(1);
          }}
          tabs={[
            { key: 'all', label: t(language, 'common.all') },
            ...STATUS_FLOW.map((s) => ({ key: s, label: t(language, `order.statuses.${s}`) })),
            { key: 'CANCELLED', label: t(language, 'order.statuses.CANCELLED') },
          ]}
        />

        <div className="border-b border-line p-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Raqam yoki telefon bo‘yicha qidirish"
            className="max-w-sm"
          />
        </div>

        <DataTable
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          onRowClick={(row) => setSelected(row.id)}
          empty={<EmptyState title={t(language, 'empty.orders')} />}
          columns={[
            {
              key: 'number',
              header: t(language, 'order.number'),
              render: (row) => <span className="font-medium tabular">{row.orderNumber}</span>,
            },
            {
              key: 'customer',
              header: t(language, 'order.customer'),
              render: (row) => (
                <div className="min-w-0">
                  <p className="truncate">
                    {row.customer
                      ? `${row.customer.firstName} ${row.customer.lastName ?? ''}`
                      : '—'}
                  </p>
                  <p className="truncate text-xs text-content-subtle">
                    {phone(row.phoneSnapshot ?? row.customer?.phone)}
                  </p>
                </div>
              ),
            },
            {
              key: 'fulfillment',
              header: 'Turi',
              secondary: true,
              render: (row) => t(language, `order.fulfillment.${row.fulfillmentType}`),
            },
            {
              key: 'status',
              header: t(language, 'order.status'),
              render: (row) => (
                <Badge
                  tone={
                    ORDER_STATUS_TONE[row.status as keyof typeof ORDER_STATUS_TONE] ?? 'neutral'
                  }
                >
                  {t(language, `order.statuses.${row.status}`)}
                </Badge>
              ),
            },
            {
              key: 'payment',
              header: 'To‘lov',
              secondary: true,
              render: (row) => (
                <Badge tone={row.paymentStatus === 'PAID' ? 'positive' : 'neutral'}>
                  {row.paymentStatus === 'PAID' ? 'To‘langan' : 'To‘lanmagan'}
                </Badge>
              ),
            },
            {
              key: 'time',
              header: 'Vaqt',
              secondary: true,
              render: (row) => (
                <span className="text-content-muted">{relative(row.createdAt, language)}</span>
              ),
            },
            {
              key: 'total',
              header: t(language, 'order.total'),
              align: 'right',
              render: (row) => (
                <span className="font-medium">{money(row.total, 'UZS', language)}</span>
              ),
            },
            {
              key: 'action',
              header: '',
              align: 'right',
              render: (row) => {
                const next = nextStatus(row.status);
                if (!next || !can('order:status')) return null;
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(event) => {
                      event.stopPropagation();
                      void changeStatus(row.id, next);
                    }}
                  >
                    {t(language, `order.statuses.${next}`)}
                  </Button>
                );
              },
            },
          ]}
        />

        <Pagination
          page={page}
          totalPages={data?.meta.totalPages ?? 1}
          total={data?.meta.total ?? 0}
          onChange={setPage}
        />
      </Card>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={detail ? `${t(language, 'order.number')} ${detail.orderNumber}` : '...'}
        description={detail ? dateTime(detail.createdAt) : undefined}
        size="lg"
      >
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                tone={
                  ORDER_STATUS_TONE[detail.status as keyof typeof ORDER_STATUS_TONE] ?? 'neutral'
                }
              >
                {t(language, `order.statuses.${detail.status}`)}
              </Badge>
              <Badge tone={detail.paymentStatus === 'PAID' ? 'positive' : 'neutral'}>
                {detail.paymentStatus === 'PAID' ? 'To‘langan' : 'To‘lanmagan'}
              </Badge>
              <Badge>{t(language, `order.fulfillment.${detail.fulfillmentType}`)}</Badge>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">
                Mahsulotlar
              </p>
              <div className="divide-y divide-line rounded-lg border border-line">
                {detail.items?.map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      {/* Names come from the order's own snapshot, so this shows what was
                          actually sold even if the product has since been renamed. */}
                      <p className="text-sm">
                        {item.nameSnapshot?.[language] ?? item.nameSnapshot?.uz}
                      </p>
                      {item.modifiers.length > 0 && (
                        <p className="text-xs text-content-subtle">
                          {item.modifiers
                            .map((m) => m.nameSnapshot?.[language] ?? m.nameSnapshot?.uz)
                            .join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right text-sm tabular">
                      <p className="text-content-muted">
                        {item.quantity} × {money(item.unitPrice, 'UZS', language)}
                      </p>
                      <p className="font-medium">{money(item.total, 'UZS', language)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 text-sm">
              {[
                [t(language, 'order.subtotal'), detail.subtotal],
                ...(detail.discountTotal > 0
                  ? [[t(language, 'order.discount'), -detail.discountTotal] as const]
                  : []),
                ...(detail.deliveryFee > 0
                  ? [[t(language, 'order.deliveryFee'), detail.deliveryFee] as const]
                  : []),
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between text-content-muted">
                  <span>{label}</span>
                  <span className="tabular">{money(value as number, 'UZS', language)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
                <span>{t(language, 'common.total')}</span>
                <span className="tabular">{money(detail.total, 'UZS', language)}</span>
              </div>
            </div>

            {detail.addressSnapshot && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-content-subtle">
                  Manzil
                </p>
                <p className="mt-1 text-sm">{detail.addressSnapshot}</p>
              </div>
            )}

            {detail.customerComment && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-content-subtle">
                  {t(language, 'order.comment')}
                </p>
                <p className="mt-1 text-sm">{detail.customerComment}</p>
              </div>
            )}

            {can('order:status') && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {nextStatus(detail.status) && (
                  <Button
                    loading={updating}
                    onClick={() => void changeStatus(detail.id, nextStatus(detail.status)!)}
                  >
                    {t(language, `order.statuses.${nextStatus(detail.status)}`)}
                  </Button>
                )}
                {detail.status !== 'COMPLETED' &&
                  detail.status !== 'CANCELLED' &&
                  can('order:cancel') && (
                    <Button
                      variant="danger"
                      disabled={updating}
                      onClick={() => void changeStatus(detail.id, 'CANCELLED')}
                    >
                      {t(language, 'order.statuses.CANCELLED')}
                    </Button>
                  )}
              </div>
            )}

            {detail.statusHistory && detail.statusHistory.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">
                  Tarix
                </p>
                <div className="space-y-1.5">
                  {detail.statusHistory.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between text-xs">
                      <span>{t(language, `order.statuses.${entry.toStatus}`)}</span>
                      <span className="text-content-subtle">{dateTime(entry.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
