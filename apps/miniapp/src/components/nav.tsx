'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@bizbot/ui';
import { useShop } from '@/lib/shop';
import { haptic } from '@/lib/telegram';

/**
 * Bottom navigation.
 *
 * Tabs come from the tenant's enabled modules, so a barbershop shows Services and
 * Bookings while a cafe shows Menu and Cart. Same component, different business.
 */
export function BottomNav({ slug, cartCount }: { slug: string; cartCount?: number }) {
  const pathname = usePathname();
  const { hasModule, data } = useShop();

  const isBooking = hasModule('BOOKING');
  const isCommerce = hasModule('ORDERS') && hasModule('CATALOG');

  const tabs = [
    { href: `/${slug}`, label: 'Asosiy', icon: '⌂' },
    ...(isCommerce
      ? [
          {
            href: `/${slug}/catalog`,
            label: data?.tenant.templateKey === 'RESTAURANT' ? 'Menyu' : 'Katalog',
            icon: '☰',
          },
          { href: `/${slug}/cart`, label: 'Savat', icon: '▤', badge: cartCount },
          { href: `/${slug}/orders`, label: 'Buyurtmalar', icon: '▦' },
        ]
      : []),
    ...(isBooking
      ? [
          { href: `/${slug}/services`, label: 'Xizmatlar', icon: '✂' },
          { href: `/${slug}/bookings`, label: 'Bronlarim', icon: '▧' },
        ]
      : []),
    { href: `/${slug}/profile`, label: 'Profil', icon: '◍' },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-raised"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex">
        {tabs.map((tab) => {
          const active =
            tab.href === `/${slug}` ? pathname === tab.href : pathname?.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={() => haptic('light')}
              className={cn(
                'tap relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition',
                active ? 'text-brand' : 'text-content-subtle',
              )}
            >
              <span className="relative text-lg leading-none" aria-hidden>
                {tab.icon}
                {'badge' in tab && tab.badge ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-medium text-brand-fg">
                    {tab.badge}
                  </span>
                ) : null}
              </span>
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
