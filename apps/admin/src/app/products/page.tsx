'use client';

import * as React from 'react';
import useSWR from 'swr';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  MoneyInput,
  Pagination,
  Select,
  Textarea,
  useToast,
} from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { api, ApiError, fetcher } from '@/lib/api';
import { money, text } from '@/lib/format';

interface Product {
  id: string;
  name: Record<string, string>;
  description?: Record<string, string> | null;
  price: number;
  oldPrice: number | null;
  sku: string | null;
  isActive: boolean;
  isFeatured: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  lowStockThreshold: number | null;
  effectiveStock: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
  categoryId: string | null;
  category?: { id: string; name: Record<string, string> } | null;
}

interface Category {
  id: string;
  name: Record<string, string>;
  children?: Category[];
}

const EMPTY_FORM = {
  nameUz: '',
  nameRu: '',
  descriptionUz: '',
  price: 0,
  oldPrice: 0,
  categoryId: '',
  sku: '',
  isActive: true,
  isFeatured: false,
  trackInventory: false,
  stockQuantity: 0,
  lowStockThreshold: 0,
};

export default function ProductsPage() {
  const { tenant, language, can } = useSession();
  const toast = useToast();

  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<Product | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Product | null>(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (debounced) query.set('search', debounced);

  const { data, isLoading, mutate } = useSWR<{
    data: Product[];
    meta: { total: number; totalPages: number };
  }>(tenant ? [`/t/${tenant.id}/catalog/products?${query}`, tenant.id] : null, fetcher);

  const { data: categories } = useSWR<Category[]>(
    tenant ? [`/t/${tenant.id}/catalog/categories`, tenant.id] : null,
    fetcher,
  );

  const flatCategories = React.useMemo(() => flatten(categories ?? []), [categories]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setCreating(true);
  }

  function openEdit(product: Product) {
    setForm({
      nameUz: product.name.uz ?? '',
      nameRu: product.name.ru ?? '',
      descriptionUz: product.description?.uz ?? '',
      price: product.price,
      oldPrice: product.oldPrice ?? 0,
      categoryId: product.categoryId ?? '',
      sku: product.sku ?? '',
      isActive: product.isActive,
      isFeatured: product.isFeatured,
      trackInventory: product.trackInventory,
      stockQuantity: product.stockQuantity,
      lowStockThreshold: product.lowStockThreshold ?? 0,
    });
    setErrors({});
    setEditing(product);
  }

  async function save() {
    setErrors({});
    if (!form.nameUz.trim()) {
      setErrors({ name: t(language, 'common.required') });
      return;
    }

    const body = {
      name: { uz: form.nameUz.trim(), ...(form.nameRu.trim() ? { ru: form.nameRu.trim() } : {}) },
      ...(form.descriptionUz.trim() ? { description: { uz: form.descriptionUz.trim() } } : {}),
      price: form.price,
      oldPrice: form.oldPrice > 0 ? form.oldPrice : null,
      categoryId: form.categoryId || null,
      sku: form.sku.trim() || undefined,
      isActive: form.isActive,
      isFeatured: form.isFeatured,
      trackInventory: form.trackInventory,
      stockQuantity: form.stockQuantity,
      lowStockThreshold:
        form.trackInventory && form.lowStockThreshold > 0 ? form.lowStockThreshold : null,
    };

    setSaving(true);
    try {
      if (editing) {
        await api(`/t/${tenant!.id}/catalog/products/${editing.id}`, {
          method: 'PATCH',
          body,
          tenantId: tenant!.id,
        });
        toast.success('Saqlandi');
      } else {
        await api(`/t/${tenant!.id}/catalog/products`, {
          method: 'POST',
          body,
          tenantId: tenant!.id,
        });
        toast.success('Mahsulot qo‘shildi');
      }
      await mutate();
      setEditing(null);
      setCreating(false);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fields = caught.fieldErrors;
        if (Object.keys(fields).length > 0) setErrors(fields);
        else toast.error(caught.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!deleting) return;
    setSaving(true);
    try {
      await api(`/t/${tenant!.id}/catalog/products/${deleting.id}`, {
        method: 'DELETE',
        tenantId: tenant!.id,
      });
      toast.success('Arxivlandi');
      await mutate();
      setDeleting(null);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t(language, 'errors.INTERNAL'));
    } finally {
      setSaving(false);
    }
  }

  const open = creating || Boolean(editing);

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.products')}
        description={data ? `${data.meta.total} ta mahsulot` : undefined}
        action={
          can('product:write') && (
            <Button onClick={openCreate}>{t(language, 'empty.productsCta')}</Button>
          )
        }
      />

      <Card>
        <div className="border-b border-line p-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`${t(language, 'common.search')} — nom yoki SKU`}
            className="max-w-sm"
          />
        </div>

        <DataTable
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          onRowClick={can('product:write') ? openEdit : undefined}
          empty={
            <EmptyState
              title={t(language, 'empty.products')}
              action={
                can('product:write') && (
                  <Button onClick={openCreate}>{t(language, 'empty.productsCta')}</Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Mahsulot',
              render: (row) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{text(row.name, language)}</p>
                  {row.sku && <p className="truncate text-xs text-content-subtle">{row.sku}</p>}
                </div>
              ),
            },
            {
              key: 'category',
              header: 'Kategoriya',
              secondary: true,
              render: (row) => (row.category ? text(row.category.name, language) : '—'),
            },
            {
              key: 'price',
              header: 'Narx',
              align: 'right',
              render: (row) => (
                <div>
                  <span className="font-medium">{money(row.price, 'UZS', language)}</span>
                  {row.oldPrice && (
                    <span className="ml-1.5 text-xs text-content-subtle line-through">
                      {money(row.oldPrice, 'UZS', language)}
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: 'stock',
              header: 'Qoldiq',
              align: 'right',
              secondary: true,
              render: (row) => {
                if (!row.trackInventory) return <span className="text-content-subtle">—</span>;
                if (row.isOutOfStock) return <Badge tone="critical">Tugadi</Badge>;
                if (row.isLowStock) return <Badge tone="warning">{row.effectiveStock}</Badge>;
                return <span className="tabular">{row.effectiveStock}</span>;
              },
            },
            {
              key: 'status',
              header: '',
              align: 'right',
              render: (row) => (
                <div className="flex justify-end gap-1">
                  {row.isFeatured && <Badge tone="brand">★</Badge>}
                  {!row.isActive && <Badge>{t(language, 'common.inactive')}</Badge>}
                </div>
              ),
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
        open={open}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
        title={editing ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'}
        footer={
          <>
            {editing && can('product:delete') && (
              <Button variant="danger" onClick={() => setDeleting(editing)} className="mr-auto">
                {t(language, 'common.delete')}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setCreating(false);
              }}
            >
              {t(language, 'common.cancel')}
            </Button>
            <Button onClick={save} loading={saving}>
              {t(language, 'common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nomi (o‘zbekcha)" required error={errors.name}>
            <Input
              value={form.nameUz}
              onChange={(e) => setForm({ ...form, nameUz: e.target.value })}
              autoFocus
            />
          </Field>

          <Field label="Nomi (ruscha)" hint="Ixtiyoriy — ruszabon mijozlar uchun">
            <Input
              value={form.nameRu}
              onChange={(e) => setForm({ ...form, nameRu: e.target.value })}
            />
          </Field>

          <Field label="Tavsif">
            <Textarea
              value={form.descriptionUz}
              onChange={(e) => setForm({ ...form, descriptionUz: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Narx" required error={errors.price}>
              <MoneyInput value={form.price} onChange={(price) => setForm({ ...form, price })} />
            </Field>
            <Field label="Eski narx" hint="Chegirmani ko‘rsatish uchun" error={errors.oldPrice}>
              <MoneyInput
                value={form.oldPrice}
                onChange={(oldPrice) => setForm({ ...form, oldPrice })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kategoriya">
              <Select
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              >
                <option value="">—</option>
                {flatCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {text(category.name, language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="SKU" error={errors.sku}>
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </Field>
          </div>

          <div className="space-y-2 rounded-lg border border-line p-3">
            {(
              [
                ['isActive', 'Faol — mijozlar ko‘radi'],
                ['isFeatured', 'Tavsiya etilgan — bosh sahifada'],
                ['trackInventory', 'Ombor qoldig‘ini hisoblash'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center justify-between">
                <span className="text-sm">{label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(form[key])}
                  onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                  className="h-5 w-5 rounded border-line text-brand focus:ring-brand/30"
                />
              </label>
            ))}
          </div>

          {form.trackInventory && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Qoldiq">
                <Input
                  type="number"
                  min={0}
                  value={form.stockQuantity}
                  onChange={(e) => setForm({ ...form, stockQuantity: Number(e.target.value) })}
                />
              </Field>
              <Field label="Kam qoldiq chegarasi" hint="Shu songa yetganda ogohlantiriladi">
                <Input
                  type="number"
                  min={0}
                  value={form.lowStockThreshold}
                  onChange={(e) => setForm({ ...form, lowStockThreshold: Number(e.target.value) })}
                />
              </Field>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={archive}
        loading={saving}
        title="Mahsulotni arxivlash"
        message={`"${deleting ? text(deleting.name, language) : ''}" arxivlanadi. Mavjud buyurtmalar o‘zgarmaydi.`}
        confirmLabel="Arxivlash"
      />
    </AppShell>
  );
}

function flatten(categories: Category[], depth = 0): (Category & { depth: number })[] {
  return categories.flatMap((category) => [
    { ...category, depth },
    ...flatten(category.children ?? [], depth + 1),
  ]);
}
