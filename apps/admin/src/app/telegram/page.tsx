'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Field, Input, useToast } from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { AppShell, PageHeader } from '@/components/shell';
import { useSession } from '@/lib/session';
import { api, ApiError, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface BotStatus {
  connected: boolean;
  botUsername?: string;
  botName?: string | null;
  status?: string;
  lastError?: string | null;
  lastUpdateAt?: string | null;
  webhookSetAt?: string | null;
  tokenMasked?: string;
  miniAppUrl?: string;
  mode?: string;
}

export default function TelegramPage() {
  const { tenant, language, can } = useSession();
  const toast = useToast();

  const [token, setToken] = React.useState('');
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [disconnecting, setDisconnecting] = React.useState(false);

  const { data, mutate, isLoading } = useSWR<BotStatus>(
    tenant ? [`/t/${tenant.id}/telegram`, tenant.id] : null,
    fetcher,
  );

  async function connect() {
    setError(null);
    setConnecting(true);
    try {
      await api(`/t/${tenant!.id}/telegram/connect`, {
        method: 'POST', body: { botToken: token.trim() }, tenantId: tenant!.id,
      });
      toast.success('Bot ulandi');
      setToken('');
      await mutate();
    } catch (caught) {
      // The API distinguishes "token is wrong" from "token is fine but the webhook could
      // not be reached", and that difference is the whole diagnosis — so it is shown.
      const message = caught instanceof ApiError ? caught.message : t(language, 'errors.INTERNAL');
      setError(message);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    try {
      await api(`/t/${tenant!.id}/telegram/connect`, { method: 'DELETE', tenantId: tenant!.id });
      toast.success('Bot uzildi');
      await mutate();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        title={t(language, 'nav.telegram')}
        description="Mijozlaringiz siz bilan o‘z botingiz orqali muloqot qiladi"
      />

      {isLoading ? null : data?.connected ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Ulangan bot"
              action={
                <Badge tone={data.status === 'ACTIVE' ? 'positive' : data.status === 'ERROR' ? 'critical' : 'warning'}>
                  {data.status}
                </Badge>
              }
            />
            <dl className="divide-y divide-line">
              {[
                ['Bot', `@${data.botUsername}`],
                ['Nomi', data.botName ?? '—'],
                // The token is only ever shown masked; the plaintext never leaves the server.
                ['Token', data.tokenMasked ?? '—'],
                ['Rejim', data.mode ?? '—'],
                ['Oxirgi xabar', data.lastUpdateAt ? dateTime(data.lastUpdateAt) : 'Hali yo‘q'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <dt className="text-content-muted">{label}</dt>
                  <dd className="truncate font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>

            {data.lastError && (
              <div className="border-t border-line bg-critical/5 px-5 py-3">
                <p className="text-sm text-critical">{data.lastError}</p>
              </div>
            )}

            {can('integration:write') && (
              <div className="border-t border-line px-5 py-4">
                <Button variant="danger" size="sm" onClick={() => setDisconnecting(true)}>
                  Botni uzish
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Mini App" description="Mijozlar shu havola orqali ilovani ochadi" />
            <div className="p-5">
              <code className="block break-all rounded-lg bg-surface-sunken px-3 py-2 text-xs">
                {data.miniAppUrl}
              </code>
              <p className="mt-3 text-sm text-content-muted">
                Bu havola botning menyu tugmasiga avtomatik ulandi. Mijoz botni ochib
                “Ilovani ochish” tugmasini bosadi.
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <Card className="max-w-xl">
          <CardHeader title="Botni ulash" description="BotFather’dan olingan tokenni kiriting" />
          <div className="space-y-4 p-5">
            <ol className="space-y-2 text-sm text-content-muted">
              <li>1. Telegram’da <span className="font-mono text-content">@BotFather</span> ni oching</li>
              <li>2. <span className="font-mono text-content">/newbot</span> buyrug‘ini yuboring</li>
              <li>3. Bot nomi va username’ni tanlang</li>
              <li>4. Olingan tokenni quyiga joylashtiring</li>
            </ol>

            <Field label="Bot token" required error={error ?? undefined}>
              <Input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>

            <Button onClick={connect} loading={connecting} disabled={!token.trim() || !can('integration:write')}>
              Ulash
            </Button>

            <p className="text-xs text-content-subtle">
              Token shifrlangan holda saqlanadi va hech qachon qaytarib berilmaydi.
            </p>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        onConfirm={disconnect}
        title="Botni uzish"
        message="Bot uziladi va mijozlar unga yoza olmaydi. Ma’lumotlaringiz saqlanib qoladi."
        confirmLabel="Uzish"
      />
    </AppShell>
  );
}
