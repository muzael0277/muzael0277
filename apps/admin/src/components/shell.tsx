'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn, Button, Select, Spinner } from '@bizbot/ui';
import { MODULE_DEFINITIONS, type ModuleKey, type Permission } from '@bizbot/rbac';
import { t } from '@bizbot/i18n';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  labelKey: string;
  /** Hidden unless the tenant has this module enabled. */
  module?: ModuleKey;
  /** Hidden unless the member holds this permission. */
  permission?: Permission;
  icon: string;
}

/**
 * Navigation is derived from modules and permissions, not hard-coded.
 *
 * A barbershop never sees "Products"; an operator never sees "Settings". Hiding a link
 * the API would refuse is not security — the guards do that — it is respect for the
 * user's attention (docs/architecture/05-modules-and-templates.md).
 */
const NAV: NavItem[] = [
  { href: '/', labelKey: 'nav.dashboard', icon: '▣' },
  { href: '/customers', labelKey: 'nav.customers', module: 'CRM', permission: 'customer:read', icon: '◍' },
  { href: '/products', labelKey: 'nav.products', module: 'CATALOG', permission: 'product:read', icon: '▦' },
  { href: '/services', labelKey: 'nav.services', module: 'SERVICES', permission: 'service:read', icon: '✂' },
  { href: '/orders', labelKey: 'nav.orders', module: 'ORDERS', permission: 'order:read', icon: '▤' },
  { href: '/bookings', labelKey: 'nav.bookings', module: 'BOOKING', permission: 'booking:read', icon: '▧' },
  { href: '/employees', labelKey: 'nav.employees', module: 'EMPLOYEES', permission: 'employee:read', icon: '◉' },
  { href: '/analytics', labelKey: 'nav.analytics', module: 'ANALYTICS', permission: 'analytics:read', icon: '◈' },
  { href: '/telegram', labelKey: 'nav.telegram', module: 'TELEGRAM', permission: 'settings:read', icon: '➤' },
  { href: '/settings', labelKey: 'nav.settings', permission: 'settings:read', icon: '⚙' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, tenant, tenants, loading, language, setLanguage, selectTenant, logout, can, hasModule } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = React.useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  if (!user) return null;

  if (!tenant) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Biznes topilmadi</h1>
          <p className="mt-2 text-sm text-content-muted">
            Boshlash uchun biznesingizni yarating.
          </p>
          <Link href="/onboarding" className="mt-5 inline-block">
            <Button>Biznes yaratish</Button>
          </Link>
        </div>
      </div>
    );
  }

  const visible = NAV.filter(
    (item) =>
      (!item.module || hasModule(item.module)) &&
      (!item.permission || can(item.permission)),
  );

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — a drawer on mobile, permanent from lg up. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-64 border-r border-line bg-surface-raised transition-transform lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-sm font-bold text-brand-fg">
            B
          </div>
          <span className="font-semibold">BizBot OS</span>
        </div>

        {tenants.length > 1 && (
          <div className="border-b border-line px-3 py-3">
            <Select
              value={tenant.id}
              onChange={(event) => selectTenant(event.target.value)}
              aria-label="Biznes"
            >
              {tenants.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
          </div>
        )}

        <nav className="space-y-0.5 p-3">
          {visible.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
                  active
                    ? 'bg-brand-subtle font-medium text-brand'
                    : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                )}
              >
                <span className="w-4 text-center opacity-70" aria-hidden>{item.icon}</span>
                {t(language, item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface-raised/90 px-4 backdrop-blur">
          <button
            type="button"
            className="rounded-md p-1.5 text-content-muted lg:hidden"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menyu"
          >
            ☰
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{tenant.name}</p>
          </div>

          <Select
            value={language}
            onChange={(event) => setLanguage(event.target.value as 'uz' | 'ru' | 'en')}
            className="h-8 w-auto text-xs"
            aria-label="Til"
          >
            <option value="uz">O‘zbekcha</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </Select>

          <Button variant="ghost" size="sm" onClick={logout}>
            {t(language, 'auth.logout')}
          </Button>
        </header>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

/** Page heading with an optional primary action. */
export function PageHeader({ title, description, action }: {
  title: string; description?: string; action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-content">{title}</h1>
        {description && <p className="mt-1 text-sm text-content-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export { MODULE_DEFINITIONS };
