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
  Pagination,
  Select,
  Tabs,
  useToast,
} from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { api, ApiError, fetcher } from '@/lib/api';
import { money, dateTime, phone, BOOKING_STATUS_TONE } from '@/lib/format';

interface Booking {
  id: string;
  bookingNumber: string;
  status: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  priceSnapshot: number;
  customer?: {
    id: string;
    firstName: string;
    lastName: string | null;
    phone: string | null;
  } | null;
  service?: { id: string; name: Record<string, string> } | null;
  resource?: { id: string; name: string } | null;
}

const NEXT_STATUS: Record<string, string | null> = {
  PENDING: 'CONFIRMED',
  CONFIRMED: 'ARRIVED',
  ARRIVED: 'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
  COMPLETED: null,
  CANCELLED: null,
  NO_SHOW: null,
};

export default function BookingsPage() {
  const { tenant, language, can } = useSession();
  const toast = useToast();

  const [status, setStatus] = React.useState('upcoming');
  const [page, setPage] = React.useState(1);
  const [busy, setBusy] = React.useState<string | null>(null);

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    sortBy: 'startsAt',
    sortOrder: 'asc',
  });
  const today = new Date().toISOString().slice(0, 10);

  if (status === 'upcoming') query.set('dateFrom', today);
  else if (status === 'today') {
    query.set('dateFrom', today);
    query.set('dateTo', today);
  } else if (status !== 'all') query.set('status', status);

  const { data, isLoading, mutate } = useSWR<{
    data: Booking[];
    meta: { total: number; totalPages: number };
  }>(tenant ? [`/t/${tenant.id}/bookings?${query}`, tenant.id] : null, fetcher, {
    refreshInterval: 30_000,
  });

  async function changeStatus(id: string, next: string) {
    setBusy(id);
    try {
      await api(`/t/${tenant!.id}/bookings/${id}/status`, {
        method: 'PATCH',
        body: { status: next },
        tenantId: tenant!.id,
      });
      toast.success(t(language, `booking.statuses.${next}`));
      await mutate();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t(language, 'errors.INTERNAL'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.bookings')}
        description={data ? `${data.meta.total} ta bron` : undefined}
      />

      <Card>
        <Tabs
          active={status}
          onChange={(key) => {
            setStatus(key);
            setPage(1);
          }}
          tabs={[
            { key: 'upcoming', label: 'Kelgusi' },
            { key: 'today', label: t(language, 'common.today') },
            { key: 'PENDING', label: t(language, 'booking.statuses.PENDING') },
            { key: 'COMPLETED', label: t(language, 'booking.statuses.COMPLETED') },
            { key: 'CANCELLED', label: t(language, 'booking.statuses.CANCELLED') },
            { key: 'all', label: t(language, 'common.all') },
          ]}
        />

        <DataTable
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          empty={<EmptyState title={t(language, 'empty.bookings')} />}
          columns={[
            {
              key: 'time',
              header: t(language, 'booking.time'),
              render: (row) => (
                <div>
                  <p className="font-medium tabular">
                    {dateTime(row.startsAt, tenant?.slug ? undefined : undefined)}
                  </p>
                  <p className="text-xs text-content-subtle tabular">
                    {row.durationMinutes} daqiqa
                  </p>
                </div>
              ),
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
                    {phone(row.customer?.phone)}
                  </p>
                </div>
              ),
            },
            {
              key: 'service',
              header: t(language, 'booking.service'),
              render: (row) => row.service?.name?.[language] ?? row.service?.name?.uz ?? '—',
            },
            {
              key: 'resource',
              header: t(language, 'booking.employee'),
              secondary: true,
              render: (row) => row.resource?.name ?? '—',
            },
            {
              key: 'status',
              header: t(language, 'order.status'),
              render: (row) => (
                <Badge
                  tone={
                    BOOKING_STATUS_TONE[row.status as keyof typeof BOOKING_STATUS_TONE] ?? 'neutral'
                  }
                >
                  {t(language, `booking.statuses.${row.status}`)}
                </Badge>
              ),
            },
            {
              key: 'price',
              header: 'Narx',
              align: 'right',
              secondary: true,
              render: (row) => money(row.priceSnapshot, 'UZS', language),
            },
            {
              key: 'action',
              header: '',
              align: 'right',
              render: (row) => {
                const next = NEXT_STATUS[row.status];
                if (!next || !can('booking:write')) return null;
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === row.id}
                    onClick={() => void changeStatus(row.id, next)}
                  >
                    {t(language, `booking.statuses.${next}`)}
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
    </AppShell>
  );
}
