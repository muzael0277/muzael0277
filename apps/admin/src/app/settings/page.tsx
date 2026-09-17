'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Badge, Button, Card, CardHeader, Field, Input, Tabs, useToast } from '@bizbot/ui';
import { MODULE_DEFINITIONS, type ModuleKey } from '@bizbot/rbac';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { api, ApiError, fetcher } from '@/lib/api';

interface ModuleRow {
  key: ModuleKey;
  label: { uz: string; ru: string };
  description: { uz: string; ru: string };
  core: boolean;
  comingSoon: boolean;
  enabled: boolean;
  missingDependencies: ModuleKey[];
  blockedBy: ModuleKey[];
}

export default function SettingsPage() {
  const { tenant, language, can, reload } = useSession();
  const toast = useToast();
  const [tab, setTab] = React.useState('modules');
  const [busy, setBusy] = React.useState<string | null>(null);

  const { data: modules, mutate } = useSWR<ModuleRow[]>(
    tenant ? [`/t/${tenant.id}/modules`, tenant.id] : null,
    fetcher,
  );

  const { data: members } = useSWR<
    {
      id: string;
      firstName: string;
      lastName: string | null;
      email: string;
      role: string;
      roleLabel: { uz: string; ru: string };
    }[]
  >(tenant && can('member:read') ? [`/t/${tenant.id}/members`, tenant.id] : null, fetcher);

  async function toggle(module: ModuleRow) {
    setBusy(module.key);
    try {
      await api(`/t/${tenant!.id}/modules`, {
        method: 'PATCH',
        body: { module: module.key, enabled: !module.enabled },
        tenantId: tenant!.id,
      });
      await Promise.all([mutate(), reload()]);
      toast.success(module.enabled ? 'O‘chirildi' : 'Yoqildi');
    } catch (caught) {
      // The API returns an actionable code plus the modules involved, so the message
      // says *which* other module is in the way rather than "invalid data".
      if (caught instanceof ApiError) {
        const details = caught.details as
          { requires?: string[]; dependents?: string[] } | undefined;
        const names = (details?.requires ?? details?.dependents ?? [])
          .map((key) => MODULE_DEFINITIONS[key as ModuleKey])
          .filter(Boolean)
          .map((definition) => (language === 'ru' ? definition!.label.ru : definition!.label.uz));

        toast.error(names.length > 0 ? `${caught.message} (${names.join(', ')})` : caught.message);
      } else {
        toast.error(t(language, 'errors.INTERNAL'));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <PageHeader title={t(language, 'nav.settings')} description={tenant?.name} />

      <Tabs
        active={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { key: 'modules', label: 'Imkoniyatlar' },
          ...(can('member:read') ? [{ key: 'team', label: t(language, 'nav.team') }] : []),
        ]}
      />

      {tab === 'modules' && (
        <Card>
          <CardHeader
            title="Imkoniyatlar"
            description="Biznesingizga keraklisini yoqing — navigatsiya va Mini App avtomatik moslashadi"
          />
          <div className="divide-y divide-line">
            {(modules ?? []).map((module) => {
              const blocked = !module.enabled && module.missingDependencies.length > 0;
              const locked = module.enabled && module.blockedBy.length > 0;

              return (
                <div key={module.key} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {language === 'ru' ? module.label.ru : module.label.uz}
                      </p>
                      {module.core && <Badge>Asosiy</Badge>}
                      {module.comingSoon && <Badge tone="info">Tez orada</Badge>}
                    </div>
                    <p className="mt-0.5 text-sm text-content-muted">
                      {language === 'ru' ? module.description.ru : module.description.uz}
                    </p>
                    {blocked && (
                      <p className="mt-1 text-xs text-warning">
                        Avval kerak:{' '}
                        {module.missingDependencies
                          .map((key) =>
                            language === 'ru'
                              ? MODULE_DEFINITIONS[key]?.label.ru
                              : MODULE_DEFINITIONS[key]?.label.uz,
                          )
                          .join(', ')}
                      </p>
                    )}
                    {locked && (
                      <p className="mt-1 text-xs text-content-subtle">
                        Bunga bog‘liq:{' '}
                        {module.blockedBy
                          .map((key) =>
                            language === 'ru'
                              ? MODULE_DEFINITIONS[key]?.label.ru
                              : MODULE_DEFINITIONS[key]?.label.uz,
                          )
                          .join(', ')}
                      </p>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant={module.enabled ? 'secondary' : 'primary'}
                    loading={busy === module.key}
                    disabled={module.core || module.comingSoon || !can('settings:write')}
                    onClick={() => void toggle(module)}
                  >
                    {module.enabled ? 'O‘chirish' : 'Yoqish'}
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === 'team' && (
        <Card>
          <CardHeader
            title={t(language, 'nav.team')}
            description="Kim nimaga kira olishini boshqaring"
          />
          <div className="divide-y divide-line">
            {(members ?? []).map((member) => (
              <div key={member.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {member.firstName} {member.lastName ?? ''}
                  </p>
                  <p className="truncate text-sm text-content-muted">{member.email}</p>
                </div>
                <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>
                  {language === 'ru' ? member.roleLabel?.ru : member.roleLabel?.uz}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </AppShell>
  );
}
