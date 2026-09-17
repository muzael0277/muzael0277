'use client';

import * as React from 'react';
import type { Language } from '@bizbot/shared';
import { initTelegram, isInsideTelegram, webApp } from './telegram';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

let token: string | null = null;

export class ShopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function shopApi<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${BASE}/shop${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ShopError(error.code ?? 'INTERNAL', error.message ?? 'Xatolik', error.details);
  }
  return payload as T;
}

/** Typed SWR fetcher: the key is the path, the generic is the response. */
export const shopFetcher = <T,>(path: string): Promise<T> => shopApi<T>(path);

export interface Bootstrap {
  tenant: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    primaryColor: string;
    currency: string;
    templateKey: string;
    description: string;
    phone: string | null;
    delivery: {
      enabled?: boolean;
      flatFee?: number;
      freeAbove?: number | null;
      minOrderTotal?: number;
    };
    loyalty: { enabled?: boolean; rate?: number };
  };
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    phone: string | null;
    language: Language;
    loyaltyBalance: number;
    orderCount: number;
    bookingCount: number;
    addresses: { id: string; label: string | null; line1: string; landmark: string | null }[];
  };
  modules: string[];
}

interface ShopValue {
  ready: boolean;
  error: string | null;
  data: Bootstrap | null;
  language: Language;
  hasModule: (module: string) => boolean;
  refresh: () => Promise<void>;
  /** True when running in a normal browser rather than inside Telegram. */
  preview: boolean;
}

const ShopContext = React.createContext<ShopValue | null>(null);

export function ShopProvider({
  tenantSlug,
  children,
}: {
  tenantSlug: string;
  children: React.ReactNode;
}) {
  const [data, setData] = React.useState<Bootstrap | null>(null);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState(false);

  const load = React.useCallback(async () => {
    setData(await shopApi<Bootstrap>('/bootstrap'));
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      initTelegram();

      if (!isInsideTelegram()) {
        // Opened outside Telegram. Say so plainly rather than showing a broken shell —
        // this is also how the app is demonstrated and developed.
        if (!cancelled) {
          setPreview(true);
          setReady(true);
        }
        return;
      }

      try {
        const session = await shopApi<{ accessToken: string }>('/auth/telegram', {
          method: 'POST',
          body: { initData: webApp()!.initData, tenantSlug },
        });
        token = session.accessToken;
        await load();
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ShopError ? caught.message : 'Ulanishda xatolik');
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantSlug, load]);

  // The business's brand colour drives the whole app, so the customer feels they are in
  // the shop rather than in a platform.
  React.useEffect(() => {
    const colour = data?.tenant.primaryColor;
    if (!colour || typeof document === 'undefined') return;
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(colour);
    if (match) {
      document.documentElement.style.setProperty(
        '--brand',
        `${parseInt(match[1]!, 16)} ${parseInt(match[2]!, 16)} ${parseInt(match[3]!, 16)}`,
      );
    }
  }, [data?.tenant.primaryColor]);

  const value = React.useMemo<ShopValue>(
    () => ({
      ready,
      error,
      data,
      preview,
      language: data?.customer.language ?? 'uz',
      hasModule: (module) => data?.modules.includes(module) ?? false,
      refresh: load,
    }),
    [ready, error, data, preview, load],
  );

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export function useShop(): ShopValue {
  const context = React.useContext(ShopContext);
  if (!context) throw new Error('useShop must be used inside a ShopProvider');
  return context;
}
