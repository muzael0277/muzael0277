'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import type { Permission, ModuleKey, Role } from '@bizbot/rbac';
import { permissionsForRole } from '@bizbot/rbac';
import type { Language } from '@bizbot/shared';
import { api, refreshSession, setAccessToken } from './api';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  language: Language;
  platformRole: 'NONE' | 'SUPPORT' | 'ADMIN';
}

export interface SessionTenant {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  templateKey: string;
  status: string;
  role: Role;
  onboardingStep: number;
  onboardingCompleted: boolean;
  modules: string[];
}

interface SessionValue {
  user: SessionUser | null;
  tenants: SessionTenant[];
  tenant: SessionTenant | null;
  loading: boolean;
  language: Language;
  setLanguage: (language: Language) => void;
  selectTenant: (tenantId: string) => void;
  /** UI-side check. The API enforces the same rule; this only avoids dead buttons. */
  can: (permission: Permission) => boolean;
  hasModule: (module: ModuleKey) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = React.createContext<SessionValue | null>(null);

const TENANT_STORAGE_KEY = 'bizbot.tenant';
const LANGUAGE_STORAGE_KEY = 'bizbot.language';

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [tenants, setTenants] = React.useState<SessionTenant[]>([]);
  const [tenantId, setTenantId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [language, setLanguageState] = React.useState<Language>('uz');

  const load = React.useCallback(async () => {
    try {
      const me = await api<{ user: SessionUser; tenants: SessionTenant[] }>('/auth/me');
      setUser(me.user);
      setTenants(me.tenants);
      setLanguageState((current) => me.user.language ?? current);

      setTenantId((current) => {
        if (current && me.tenants.some((t) => t.id === current)) return current;
        const remembered =
          typeof window !== 'undefined' ? localStorage.getItem(TENANT_STORAGE_KEY) : null;
        if (remembered && me.tenants.some((t) => t.id === remembered)) return remembered;
        return me.tenants[0]?.id ?? null;
      });
    } catch {
      setUser(null);
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // On first load the access token is gone (it lives in memory), but the refresh cookie
  // survives — so a page reload restores the session instead of bouncing to login.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored =
        typeof window !== 'undefined' ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
      if (stored === 'uz' || stored === 'ru' || stored === 'en') setLanguageState(stored);

      await refreshSession();
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  React.useEffect(() => {
    if (loading) return;
    const onAuthPage = pathname?.startsWith('/auth');
    if (!user && !onAuthPage) router.replace('/auth/login');
    if (user && onAuthPage) router.replace('/');
  }, [loading, user, pathname, router]);

  const tenant = React.useMemo(
    () => tenants.find((t) => t.id === tenantId) ?? null,
    [tenants, tenantId],
  );

  // A tenant's brand colour is applied at runtime rather than compiled in, which is what
  // makes white-labelling a settings change later rather than a rebuild.
  React.useEffect(() => {
    if (!tenant?.primaryColor || typeof document === 'undefined') return;
    const rgb = hexToRgb(tenant.primaryColor);
    if (rgb) document.documentElement.style.setProperty('--brand', rgb);
    return () => {
      document.documentElement.style.removeProperty('--brand');
    };
  }, [tenant?.primaryColor]);

  React.useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }, [language]);

  const permissions = React.useMemo(
    () => (tenant ? permissionsForRole(tenant.role) : new Set<Permission>()),
    [tenant],
  );

  const value = React.useMemo<SessionValue>(
    () => ({
      user,
      tenants,
      tenant,
      loading,
      language,
      setLanguage: (next) => {
        setLanguageState(next);
        localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
      },
      selectTenant: (id) => {
        setTenantId(id);
        localStorage.setItem(TENANT_STORAGE_KEY, id);
      },
      can: (permission) => permissions.has(permission),
      hasModule: (module) => tenant?.modules.includes(module) ?? false,
      login: async (email, password) => {
        const result = await api<{ accessToken: string }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        setAccessToken(result.accessToken);
        await load();
        router.replace('/');
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setAccessToken(null);
        setUser(null);
        setTenants([]);
        setTenantId(null);
        router.replace('/auth/login');
      },
      reload: load,
    }),
    [user, tenants, tenant, loading, language, permissions, load, router],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}

function hexToRgb(hex: string): string | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return `${parseInt(match[1]!, 16)} ${parseInt(match[2]!, 16)} ${parseInt(match[3]!, 16)}`;
}
