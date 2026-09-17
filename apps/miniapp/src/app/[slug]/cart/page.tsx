'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Button, Card, EmptyState, Field, Input, Select, Skeleton, Textarea, useToast } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { useShop, shopApi, ShopError, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';
import { haptic } from '@/lib/telegram';

interface CartSummary {
  cart: {
    id: string; promoCode: string | null;
    items: {
      id: string; productId: string; name: string; variantName: string | null;
      imageUrl: string | null; quantity: number;
      modifiers: { optionId: string; name: string; price: number }[];
      unitPrice: number; modifiersPrice: number; total: number;
    }[];
  };
  pricing: {
    subtotal: number; promoDiscount: number; loyaltyDiscount: number;
    discountTotal: number; deliveryFee: number; total: number; loyaltyEarn: number;
  } | null;
}

export default function CartPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const toast = useToast();
  const { data: shop } = useShop();

  const [fulfillment, setFulfillment] = React.useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [promo, setPromo] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [phone, setPhone] = React.useState(shop?.customer.phone ?? '');
  const [comment, setComment] = React.useState('');
  const [method, setMethod] = React.useState('CASH');
  const [busy, setBusy] = React.useState(false);

  const { data, mutate, isLoading } = useSWR<CartSummary>(
    shop ? `/cart?fulfillmentType=${fulfillment}` : null,
    shopFetcher,
  );

  const money = (value: number) =>
    formatMoney(value, (shop?.tenant.currency ?? 'UZS') as never, shop?.customer.language ?? 'uz');

  async function updateQuantity(itemId: string, quantity: number) {
    haptic('light');
    try {
      await shopApi(`/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } });
      await mutate();
    } catch (caught) {
      toast.error(caught instanceof ShopError ? caught.message : 'Xatolik');
    }
  }

  async function applyPromo() {
    if (!promo.trim()) return;
    try {
      await shopApi('/cart/promo', { method: 'POST', body: { code: promo.trim().toUpperCase() } });
      await mutate();
      haptic('success');
      toast.success('Promokod qo‘llandi');
    } catch (caught) {
      haptic('error');
      // The API says exactly why — expired, limit reached, minimum not met — and that is
      // far more useful than a generic "invalid code".
      toast.error(caught instanceof ShopError ? caught.message : 'Promokod qo‘llanmadi');
    }
  }

  async function checkout() {
    setBusy(true);
    try {
      const order = await shopApi<{ orderNumber: string }>('/checkout', {
        method: 'POST',
        body: {
          fulfillmentType: fulfillment,
          paymentMethod: method,
          phone: phone || undefined,
          comment: comment || undefined,
          ...(fulfillment === 'DELIVERY'
            ? { address: { line1: address, saveForLater: true } }
            : { branchId: undefined }),
        },
      });
      haptic('success');
      toast.success(`Buyurtma qabul qilindi: ${order.orderNumber}`);
      await mutate();
      router.push(`/${params.slug}/orders`);
    } catch (caught) {
      haptic('error');
      toast.error(caught instanceof ShopError ? caught.message : 'Buyurtma yaratilmadi');
    } finally {
      setBusy(false);
    }
  }

  const items = data?.cart.items ?? [];
  const pricing = data?.pricing;

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-24" /><Skeleton className="h-24" />
        <BottomNav slug={params.slug} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4">
        <EmptyState
          title="Savat bo‘sh"
          description="Katalogdan mahsulot tanlang"
          action={<Button onClick={() => router.push(`/${params.slug}/catalog`)}>Katalogga o‘tish</Button>}
        />
        <BottomNav slug={params.slug} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Savat</h1>

      <div className="space-y-2">
        {items.map((item) => (
          <Card key={item.id} className="flex gap-3 p-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-sunken">
              {item.imageUrl && <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{item.name}</p>
              {item.variantName && <p className="text-xs text-content-subtle">{item.variantName}</p>}
              {item.modifiers.length > 0 && (
                <p className="text-xs text-content-subtle">
                  {item.modifiers.map((m) => m.name).join(', ')}
                </p>
              )}
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-1 rounded-lg border border-line">
                  <button
                    onClick={() => void updateQuantity(item.id, item.quantity - 1)}
                    className="tap px-2.5 text-content-muted"
                    aria-label="Kamaytirish"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm tabular">{item.quantity}</span>
                  <button
                    onClick={() => void updateQuantity(item.id, item.quantity + 1)}
                    className="tap px-2.5 text-content-muted"
                    aria-label="Ko‘paytirish"
                  >
                    +
                  </button>
                </div>
                <span className="font-semibold tabular">{money(item.total)}</span>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex gap-2">
          {(['DELIVERY', 'PICKUP'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setFulfillment(option)}
              className={`tap flex-1 rounded-lg border py-2.5 text-sm transition ${
                fulfillment === option ? 'border-brand bg-brand-subtle text-brand' : 'border-line'
              }`}
            >
              {option === 'DELIVERY' ? 'Yetkazib berish' : 'Olib ketish'}
            </button>
          ))}
        </div>

        {fulfillment === 'DELIVERY' && (
          <Field label="Manzil" required>
            <Input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Ko‘cha, uy, xonadon"
            />
          </Field>
        )}

        <Field label="Telefon" required>
          <Input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+998 90 123 45 67"
          />
        </Field>

        <Field label="To‘lov usuli">
          <Select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="CASH">Naqd pul</option>
            <option value="CLICK">Click</option>
            <option value="PAYME">Payme</option>
          </Select>
        </Field>

        <Field label="Izoh">
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Qo‘shimcha izoh"
            className="min-h-16"
          />
        </Field>

        <div className="flex gap-2">
          <Input
            value={promo}
            onChange={(event) => setPromo(event.target.value.toUpperCase())}
            placeholder="Promokod"
            className="uppercase"
          />
          <Button variant="secondary" onClick={applyPromo}>Qo‘llash</Button>
        </div>
      </Card>

      {/* Every figure here comes from the server's own calculation — the app never adds
          anything up itself, which is what keeps the displayed total and the charged
          total the same number. */}
      {pricing && (
        <Card className="space-y-1.5 p-4 text-sm">
          <Row label="Mahsulotlar" value={money(pricing.subtotal)} />
          {pricing.promoDiscount > 0 && (
            <Row label="Promokod" value={`−${money(pricing.promoDiscount)}`} tone="positive" />
          )}
          {pricing.loyaltyDiscount > 0 && (
            <Row label="Bonus" value={`−${money(pricing.loyaltyDiscount)}`} tone="positive" />
          )}
          {pricing.deliveryFee > 0 && <Row label="Yetkazib berish" value={money(pricing.deliveryFee)} />}
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
            <span>Jami</span>
            <span className="tabular">{money(pricing.total)}</span>
          </div>
          {pricing.loyaltyEarn > 0 && (
            <p className="pt-1 text-xs text-content-subtle">
              Bu buyurtma uchun {money(pricing.loyaltyEarn)} bonus olasiz
            </p>
          )}
        </Card>
      )}

      <Button
        fullWidth
        size="lg"
        loading={busy}
        disabled={fulfillment === 'DELIVERY' && !address.trim()}
        onClick={checkout}
      >
        Buyurtma berish{pricing ? ` — ${money(pricing.total)}` : ''}
      </Button>

      <BottomNav slug={params.slug} cartCount={items.length} />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'positive' }) {
  return (
    <div className="flex justify-between">
      <span className="text-content-muted">{label}</span>
      <span className={`tabular ${tone === 'positive' ? 'text-positive' : ''}`}>{value}</span>
    </div>
  );
}
