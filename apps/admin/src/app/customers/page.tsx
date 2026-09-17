'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Badge, Button, Card, DataTable, EmptyState, Input, Pagination, Tabs } from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { fetcher } from '@/lib/api';
import { money, phone, relative } from '@/lib/format';

interface Customer {
  id: string; firstName: string; lastName: string | null; phone: string | null;
  telegramUsername: string | null; language: string;
  totalSpent: string | number; orderCount: number; bookingCount: number;
  loyaltyBalance: number; lastActivityAt: string; createdAt: string;
  tags: { id: string; name: string; color: string }[];
}

interface Segment {
  key: string; name: { uz: string; ru: string }; count: number;
}

export default function CustomersPage() {
  const { tenant, language } = useSession();
  const [search, setSearch] = React.useState('');
  const [segment, setSegment] = React.useState('all');
  const [page, setPage] = React.useState(1);

  // Debounced so typing does not fire a request per keystroke.
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (debounced) query.set('search', debounced);
  if (segment !== 'all') query.set('segmentKey', segment);

  const { data, isLoading } = useSWR<{ data: Customer[]; meta: { total: number; totalPages: number } }>(
    tenant ? [`/t/${tenant.id}/customers?${query}`, tenant.id] : null,
    fetcher,
  );

  const { data: segments } = useSWR<Segment[]>(
    tenant ? [`/t/${tenant.id}/customers/segments`, tenant.id] : null,
    fetcher,
  );

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.customers')}
        description={data ? `${data.meta.total} ta mijoz` : undefined}
      />

      <Card>
        {/* Segments are stored filters the tenant can edit, not hard-coded tabs. */}
        <Tabs
          active={segment}
          onChange={(key) => { setSegment(key); setPage(1); }}
          tabs={[
            { key: 'all', label: t(language, 'common.all'), count: data?.meta.total },
            ...(segments ?? []).map((s) => ({
              key: s.key,
              label: language === 'ru' ? s.name.ru : s.name.uz,
              count: s.count,
            })),
          ]}
        />

        <div className="border-b border-line p-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`${t(language, 'common.search')} — ism, telefon, username`}
            className="max-w-sm"
          />
        </div>

        <DataTable
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          empty={
            <EmptyState
              title={t(language, 'empty.customers')}
              description="Telegram bot ishga tushgach, mijozlaringiz avtomatik shu yerda paydo bo‘ladi."
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Mijoz',
              render: (row) => (
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-xs font-medium text-brand">
                    {row.firstName.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {row.firstName} {row.lastName ?? ''}
                    </p>
                    {row.telegramUsername && (
                      <p className="truncate text-xs text-content-subtle">@{row.telegramUsername}</p>
                    )}
                  </div>
                </div>
              ),
            },
            { key: 'phone', header: 'Telefon', secondary: true, render: (row) => phone(row.phone) },
            {
              key: 'tags', header: 'Teglar', secondary: true,
              render: (row) => row.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {row.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded px-1.5 py-0.5 text-xs"
                      style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              ) : '—',
            },
            { key: 'orders', header: 'Buyurtma', align: 'right', secondary: true, render: (row) => row.orderCount },
            {
              key: 'spent', header: 'Sarflagan', align: 'right',
              render: (row) => money(row.totalSpent, 'UZS', language),
            },
            {
              key: 'bonus', header: 'Bonus', align: 'right', secondary: true,
              render: (row) => row.loyaltyBalance > 0
                ? <Badge tone="brand">{money(row.loyaltyBalance, 'UZS', language)}</Badge>
                : '—',
            },
            {
              key: 'activity', header: 'Faollik', align: 'right', secondary: true,
              render: (row) => <span className="text-content-muted">{relative(row.lastActivityAt, language)}</span>,
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
