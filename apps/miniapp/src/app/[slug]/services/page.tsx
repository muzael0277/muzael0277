'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Badge, Button, Card, EmptyState, Skeleton, useToast } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { useShop, shopApi, ShopError, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';
import { haptic } from '@/lib/telegram';

interface Service {
  id: string; name: string; description: string; price: number;
  durationMinutes: number; imageUrl: string | null;
  category: { id: string; name: string } | null;
}

interface Availability {
  date: string;
  service: { id: string; name: Record<string, string>; price: number; durationMinutes: number };
  resources: {
    resource: { id: string; name: string; kind: string; avatarUrl: string | null };
    slots: { startsAt: string; label: string }[];
  }[];
  anySlots: { startsAt: string; label: string; resourceIds: string[] }[];
}

/**
 * Booking flow: service → specialist → day → time → confirm.
 *
 * One decision per screen. A single form with four dropdowns is faster to build and
 * much worse to use on a phone with one hand.
 */
export default function ServicesPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const toast = useToast();
  const { data: shop } = useShop();

  const [service, setService] = React.useState<Service | null>(null);
  const [resourceId, setResourceId] = React.useState<string | null>(null);
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [slot, setSlot] = React.useState<string | null>(null);
  const [booking, setBooking] = React.useState(false);

  const { data: services } = useSWR<Service[]>(shop ? '/services' : null, shopFetcher);

  const { data: availability, isLoading: loadingSlots } = useSWR<Availability>(
    service ? `/bookings/availability?serviceId=${service.id}&date=${date}` : null,
    shopFetcher,
  );

  const money = (value: number) =>
    formatMoney(value, (shop?.tenant.currency ?? 'UZS') as never, shop?.customer.language ?? 'uz');

  // The next 14 days; a customer booking further out is rare enough to not clutter the UI.
  const days = React.useMemo(
    () => Array.from({ length: 14 }, (_, i) => {
      const day = new Date();
      day.setDate(day.getDate() + i);
      return day;
    }),
    [],
  );

  const slots = resourceId
    ? availability?.resources.find((r) => r.resource.id === resourceId)?.slots ?? []
    : availability?.anySlots ?? [];

  async function confirm() {
    if (!service || !slot) return;
    setBooking(true);
    try {
      const result = await shopApi<{ bookingNumber: string }>('/bookings', {
        method: 'POST',
        body: { serviceId: service.id, startsAt: slot, ...(resourceId ? { resourceId } : {}) },
      });
      haptic('success');
      toast.success(`Bron tasdiqlandi: ${result.bookingNumber}`);
      router.push(`/${params.slug}/bookings`);
    } catch (caught) {
      haptic('error');
      // BOOKING_SLOT_TAKEN is the expected race: someone else took it between render and
      // tap. Telling the customer plainly and refreshing is the right response.
      toast.error(caught instanceof ShopError ? caught.message : 'Bron qilinmadi');
    } finally {
      setBooking(false);
    }
  }

  if (!service) {
    return (
      <div className="p-4">
        <h1 className="mb-3 text-lg font-semibold">Xizmatlar</h1>
        {!services ? (
          <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
        ) : services.length === 0 ? (
          <EmptyState title="Xizmatlar qo‘shilmagan" />
        ) : (
          <div className="space-y-2">
            {services.map((item) => (
              <button key={item.id} onClick={() => { haptic('light'); setService(item); }} className="w-full text-left">
                <Card className="flex items-center gap-3 p-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{item.name}</p>
                    {item.description && (
                      <p className="line-clamp-1 text-sm text-content-muted">{item.description}</p>
                    )}
                    <p className="mt-1 text-xs text-content-subtle">{item.durationMinutes} daqiqa</p>
                  </div>
                  <span className="shrink-0 font-semibold tabular">{money(item.price)}</span>
                </Card>
              </button>
            ))}
          </div>
        )}
        <BottomNav slug={params.slug} />
      </div>
    );
  }

  return (
    <div className="p-4">
      <button
        onClick={() => { setService(null); setSlot(null); setResourceId(null); }}
        className="tap mb-3 text-sm text-brand"
      >
        ← Xizmatlar
      </button>

      <Card className="mb-4 p-4">
        <p className="font-medium">{service.name}</p>
        <p className="mt-0.5 text-sm text-content-muted">
          {service.durationMinutes} daqiqa · {money(service.price)}
        </p>
      </Card>

      {availability && availability.resources.length > 1 && (
        <section className="mb-4">
          <p className="mb-2 text-sm font-medium text-content-muted">Usta</p>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            <button
              onClick={() => { setResourceId(null); setSlot(null); }}
              className={`tap shrink-0 rounded-xl border px-3.5 py-2 text-sm ${
                resourceId === null ? 'border-brand bg-brand-subtle text-brand' : 'border-line'
              }`}
            >
              Farqi yo‘q
            </button>
            {availability.resources.map((entry) => (
              <button
                key={entry.resource.id}
                onClick={() => { setResourceId(entry.resource.id); setSlot(null); }}
                disabled={entry.slots.length === 0}
                className={`tap shrink-0 rounded-xl border px-3.5 py-2 text-sm ${
                  resourceId === entry.resource.id ? 'border-brand bg-brand-subtle text-brand' : 'border-line'
                } ${entry.slots.length === 0 ? 'opacity-40' : ''}`}
              >
                {entry.resource.name}
                {entry.slots.length === 0 && <span className="ml-1 text-xs">band</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mb-4">
        <p className="mb-2 text-sm font-medium text-content-muted">Sana</p>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {days.map((day) => {
            const value = day.toISOString().slice(0, 10);
            const active = value === date;
            return (
              <button
                key={value}
                onClick={() => { setDate(value); setSlot(null); }}
                className={`tap flex shrink-0 flex-col items-center rounded-xl border px-3 py-2 ${
                  active ? 'border-brand bg-brand-subtle text-brand' : 'border-line'
                }`}
              >
                <span className="text-[11px] uppercase opacity-70">
                  {day.toLocaleDateString('uz-UZ', { weekday: 'short' })}
                </span>
                <span className="text-base font-semibold tabular">{day.getDate()}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-medium text-content-muted">Vaqt</p>
        {loadingSlots ? (
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-11" />)}
          </div>
        ) : slots.length === 0 ? (
          <EmptyState title="Bu kunda bo‘sh vaqt yo‘q" description="Boshqa sanani tanlang" />
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {slots.map((option) => (
              <button
                key={option.startsAt}
                onClick={() => { haptic('light'); setSlot(option.startsAt); }}
                className={`tap rounded-lg border py-2.5 text-sm tabular transition ${
                  slot === option.startsAt ? 'border-brand bg-brand text-brand-fg' : 'border-line'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {slot && (
        <div className="sticky bottom-20 mt-5">
          <Button fullWidth size="lg" loading={booking} onClick={confirm}>
            Bron qilish — {money(service.price)}
          </Button>
        </div>
      )}

      <BottomNav slug={params.slug} />
    </div>
  );
}
