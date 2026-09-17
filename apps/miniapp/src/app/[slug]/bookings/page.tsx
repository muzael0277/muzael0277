'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Skeleton, useToast } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { t } from '@bizbot/i18n';
import { useShop, shopApi, ShopError, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';
import { haptic } from '@/lib/telegram';

const TONE = {
  PENDING: 'warning', CONFIRMED: 'info', ARRIVED: 'brand', IN_PROGRESS: 'brand',
  COMPLETED: 'positive', CANCELLED: 'critical', NO_SHOW: 'critical',
} as const;

export default function BookingsPage({ params }: { params: { slug: string } }) {
  const toast = useToast();
  const { data: shop } = useShop();
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const { data, isLoading, mutate } = useSWR<{ data: Booking[] }>(
    shop ? '/bookings?pageSize=30' : null,
    shopFetcher,
  );

  const language = shop?.customer.language ?? 'uz';
  const money = (value: number) => formatMoney(value, (shop?.tenant.currency ?? 'UZS') as never, language);

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    try {
      await shopApi(`/bookings/${cancelling}/cancel`, { method: 'POST', body: {} });
      haptic('success');
      toast.success('Bron bekor qilindi');
      await mutate();
      setCancelling(null);
    } catch (caught) {
      haptic('error');
      // Past the cancellation deadline the API refuses and says so — the customer needs
      // to call the business instead, and a vague error would leave them stuck.
      toast.error(caught instanceof ShopError ? caught.message : 'Bekor qilinmadi');
    } finally {
      setBusy(false);
    }
  }

  const upcoming = (data?.data ?? []).filter(
    (b) => new Date(b.startsAt) > new Date() && !['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(b.status),
  );
  const past = (data?.data ?? []).filter((b) => !upcoming.includes(b));

  return (
    <div className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Bronlarim</h1>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState title={t(language, 'empty.bookings')} />
      ) : (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <section>
              <p className="mb-2 text-sm font-medium text-content-muted">Kelgusi</p>
              <div className="space-y-2">
                {upcoming.map((booking) => (
                  <BookingCard
                    key={booking.id}
                    booking={booking}
                    language={language}
                    money={money}
                    onCancel={() => setCancelling(booking.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section>
              <p className="mb-2 text-sm font-medium text-content-muted">O‘tgan</p>
              <div className="space-y-2 opacity-70">
                {past.map((booking) => (
                  <BookingCard key={booking.id} booking={booking} language={language} money={money} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        onConfirm={cancel}
        loading={busy}
        title="Bronni bekor qilish"
        message="Bron bekor qilinadi. Yangi vaqt tanlashingiz mumkin."
        confirmLabel="Bekor qilish"
        cancelLabel="Yopish"
      />

      <BottomNav slug={params.slug} />
    </div>
  );
}

function BookingCard({
  booking, language, money, onCancel,
}: {
  booking: Booking; language: 'uz' | 'ru' | 'en';
  money: (value: number) => string; onCancel?: () => void;
}) {
  const start = new Date(booking.startsAt);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {booking.service?.name?.[language] ?? booking.service?.name?.uz ?? '—'}
          </p>
          <p className="mt-0.5 text-sm text-content-muted tabular">
            {start.toLocaleString('ru-RU', {
              day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            })}
          </p>
          {booking.resource && (
            <p className="mt-0.5 text-xs text-content-subtle">{booking.resource.name}</p>
          )}
        </div>
        <Badge tone={TONE[booking.status as keyof typeof TONE] ?? 'neutral'}>
          {t(language, `booking.statuses.${booking.status}`)}
        </Badge>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="font-semibold tabular">{money(booking.priceSnapshot)}</span>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>Bekor qilish</Button>
        )}
      </div>
    </Card>
  );
}

interface Booking {
  id: string; bookingNumber: string; status: string; startsAt: string; priceSnapshot: number;
  service?: { name: Record<string, string> } | null;
  resource?: { name: string } | null;
}
