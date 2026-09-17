'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Badge, Button, Card, EmptyState, Input, Modal, Skeleton, useToast } from '@bizbot/ui';
import { formatMoney } from '@bizbot/shared';
import { useShop, shopApi, ShopError, shopFetcher } from '@/lib/shop';
import { BottomNav } from '@/components/nav';
import { haptic } from '@/lib/telegram';

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  oldPrice: number | null;
  image: string | null;
  categoryId: string | null;
  isAvailable: boolean;
  variants: { id: string; name: string; priceModifier: number; isAvailable: boolean }[];
}

interface ProductDetail extends Product {
  images: string[];
  modifierGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    options: { id: string; name: string; price: number; isDefault: boolean }[];
  }[];
}

export default function CatalogPage({ params }: { params: { slug: string } }) {
  const searchParams = useSearchParams();
  const { data: shop } = useShop();
  const toast = useToast();

  const [category, setCategory] = React.useState(searchParams.get('category') ?? '');
  const [search, setSearch] = React.useState('');
  const [openProduct, setOpenProduct] = React.useState<string | null>(null);
  const [cartCount, setCartCount] = React.useState(0);

  const { data } = useSWR<{ categories: { id: string; name: string }[]; products: Product[] }>(
    shop ? `/catalog${category ? `?categoryId=${category}` : ''}` : null,
    shopFetcher,
  );

  const { data: detail } = useSWR<ProductDetail>(
    openProduct ? `/catalog/${openProduct}` : null,
    shopFetcher,
  );

  const { data: cart, mutate: mutateCart } = useSWR<{ cart: { items: unknown[] } }>(
    shop ? '/cart' : null,
    shopFetcher,
  );

  React.useEffect(() => {
    setCartCount(cart?.cart.items.length ?? 0);
  }, [cart]);

  const money = (value: number) =>
    formatMoney(value, (shop?.tenant.currency ?? 'UZS') as never, shop?.customer.language ?? 'uz');

  const visible = React.useMemo(() => {
    const products = data?.products ?? [];
    if (!search.trim()) return products;
    const query = search.toLowerCase();
    return products.filter((p) => p.name.toLowerCase().includes(query));
  }, [data, search]);

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-30 border-b border-line bg-surface-raised/95 px-4 py-3 backdrop-blur">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Qidirish"
          className="h-11"
        />
        {data && data.categories.length > 0 && (
          <div className="-mx-4 mt-2.5 flex gap-2 overflow-x-auto px-4">
            <button
              onClick={() => setCategory('')}
              className={`tap shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${
                category === '' ? 'bg-brand text-brand-fg' : 'bg-surface-sunken text-content-muted'
              }`}
            >
              Barchasi
            </button>
            {data.categories.map((item) => (
              <button
                key={item.id}
                onClick={() => setCategory(item.id)}
                className={`tap shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${
                  category === item.id
                    ? 'bg-brand text-brand-fg'
                    : 'bg-surface-sunken text-content-muted'
                }`}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-4">
        {!data ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title="Hech narsa topilmadi" />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((product) => (
              <button
                key={product.id}
                onClick={() => {
                  haptic('light');
                  setOpenProduct(product.id);
                }}
                className="text-left"
                disabled={!product.isAvailable}
              >
                <Card className={`overflow-hidden ${!product.isAvailable ? 'opacity-50' : ''}`}>
                  <div className="relative aspect-square bg-surface-sunken">
                    {product.image && (
                      <img src={product.image} alt="" className="h-full w-full object-cover" />
                    )}
                    {product.oldPrice && (
                      <span className="absolute left-2 top-2 rounded-md bg-critical px-1.5 py-0.5 text-xs font-medium text-white">
                        −{Math.round((1 - product.price / product.oldPrice) * 100)}%
                      </span>
                    )}
                    {/* Out-of-stock items stay visible but unbuyable, so the menu does not
                        shrink mysteriously between visits. */}
                    {!product.isAvailable && (
                      <span className="absolute inset-x-2 bottom-2 rounded-md bg-content/80 py-1 text-center text-xs text-surface">
                        Tugadi
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 text-sm">{product.name}</p>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-semibold tabular">{money(product.price)}</span>
                      {product.oldPrice && (
                        <span className="text-xs text-content-subtle line-through tabular">
                          {money(product.oldPrice)}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}
      </div>

      <ProductSheet
        detail={detail ?? null}
        open={Boolean(openProduct)}
        onClose={() => setOpenProduct(null)}
        money={money}
        onAdded={async () => {
          haptic('success');
          toast.success('Savatga qo‘shildi');
          setOpenProduct(null);
          await mutateCart();
        }}
        onError={(message) => {
          haptic('error');
          toast.error(message);
        }}
      />

      <BottomNav slug={params.slug} cartCount={cartCount} />
    </div>
  );
}

/**
 * Product sheet.
 *
 * Required modifier groups are pre-selected with their default, so the common case is a
 * single tap. The server validates the selection anyway — this only avoids handing the
 * customer an error they could not have anticipated.
 */
function ProductSheet({
  detail,
  open,
  onClose,
  money,
  onAdded,
  onError,
}: {
  detail: ProductDetail | null;
  open: boolean;
  onClose: () => void;
  money: (value: number) => string;
  onAdded: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [quantity, setQuantity] = React.useState(1);
  const [variantId, setVariantId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [adding, setAdding] = React.useState(false);

  React.useEffect(() => {
    if (!detail) return;
    setQuantity(1);
    setVariantId(detail.variants[0]?.id ?? null);
    const defaults = new Set<string>();
    for (const group of detail.modifierGroups) {
      if (group.minSelect > 0) {
        const preferred = group.options.find((option) => option.isDefault) ?? group.options[0];
        if (preferred) defaults.add(preferred.id);
      }
    }
    setSelected(defaults);
  }, [detail]);

  if (!detail) {
    return (
      <Modal open={open} onClose={onClose} title="...">
        <Skeleton className="h-32" />
      </Modal>
    );
  }

  const variant = detail.variants.find((v) => v.id === variantId);
  const modifiersPrice = detail.modifierGroups
    .flatMap((group) => group.options)
    .filter((option) => selected.has(option.id))
    .reduce((sum, option) => sum + option.price, 0);
  const unit = detail.price + (variant?.priceModifier ?? 0) + modifiersPrice;

  function toggleOption(groupId: string, optionId: string) {
    const group = detail!.modifierGroups.find((g) => g.id === groupId)!;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(optionId)) {
        // A required group must keep at least its minimum selected.
        const chosen = group.options.filter((o) => next.has(o.id)).length;
        if (chosen <= group.minSelect) return current;
        next.delete(optionId);
        return next;
      }
      if (group.maxSelect === 1) {
        for (const option of group.options) next.delete(option.id);
      } else {
        const chosen = group.options.filter((o) => next.has(o.id)).length;
        if (chosen >= group.maxSelect) return current;
      }
      next.add(optionId);
      return next;
    });
  }

  async function addToCart() {
    setAdding(true);
    try {
      await shopApi('/cart/items', {
        method: 'POST',
        body: {
          productId: detail!.id,
          variantId,
          quantity,
          modifierOptionIds: [...selected],
        },
      });
      await onAdded();
    } catch (caught) {
      onError(caught instanceof ShopError ? caught.message : 'Qo‘shib bo‘lmadi');
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={detail.name}
      footer={
        <div className="flex w-full items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-line">
            <button
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="tap px-3 text-lg text-content-muted"
              aria-label="Kamaytirish"
            >
              −
            </button>
            <span className="w-8 text-center font-medium tabular">{quantity}</span>
            <button
              onClick={() => setQuantity((q) => Math.min(99, q + 1))}
              className="tap px-3 text-lg text-content-muted"
              aria-label="Ko‘paytirish"
            >
              +
            </button>
          </div>
          <Button onClick={addToCart} loading={adding} fullWidth disabled={!detail.isAvailable}>
            {money(unit * quantity)} — savatga
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {detail.images[0] && (
          <img
            src={detail.images[0]}
            alt=""
            className="aspect-video w-full rounded-lg object-cover"
          />
        )}
        {detail.description && <p className="text-sm text-content-muted">{detail.description}</p>}

        {detail.variants.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Variant</p>
            <div className="flex flex-wrap gap-2">
              {detail.variants.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setVariantId(option.id)}
                  disabled={!option.isAvailable}
                  className={`tap rounded-lg border px-3 py-2 text-sm transition ${
                    variantId === option.id
                      ? 'border-brand bg-brand-subtle text-brand'
                      : 'border-line'
                  } ${!option.isAvailable ? 'opacity-40' : ''}`}
                >
                  {option.name}
                  {option.priceModifier !== 0 && (
                    <span className="ml-1 text-xs">+{money(option.priceModifier)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {detail.modifierGroups.map((group) => (
          <div key={group.id}>
            <div className="mb-2 flex items-center gap-2">
              <p className="text-sm font-medium">{group.name}</p>
              {group.minSelect > 0 && <Badge tone="brand">Majburiy</Badge>}
              {group.maxSelect > 1 && (
                <span className="text-xs text-content-subtle">maks. {group.maxSelect}</span>
              )}
            </div>
            <div className="space-y-1.5">
              {group.options.map((option) => (
                <label
                  key={option.id}
                  className={`tap flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2.5 transition ${
                    selected.has(option.id) ? 'border-brand bg-brand-subtle' : 'border-line'
                  }`}
                >
                  <span className="text-sm">{option.name}</span>
                  <span className="flex items-center gap-2">
                    {option.price > 0 && (
                      <span className="text-sm text-content-muted tabular">
                        +{money(option.price)}
                      </span>
                    )}
                    <input
                      type={group.maxSelect === 1 ? 'radio' : 'checkbox'}
                      checked={selected.has(option.id)}
                      onChange={() => toggleOption(group.id, option.id)}
                      className="h-5 w-5 text-brand focus:ring-brand/30"
                    />
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
