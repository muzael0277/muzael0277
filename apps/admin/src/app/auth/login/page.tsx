'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, Card, Field, Input, useToast } from '@bizbot/ui';
import { t } from '@bizbot/i18n';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const { login, language } = useSession();
  const toast = useToast();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (caught) {
      // The API already localizes its message, so it is shown as-is rather than being
      // re-translated here and drifting out of step.
      const message = caught instanceof ApiError ? caught.message : t(language, 'errors.INTERNAL');
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-bold text-brand-fg">
            B
          </div>
          <h1 className="text-xl font-semibold">BizBot OS</h1>
          <p className="mt-1 text-sm text-content-muted">
            Telegram’da biznesingiz uchun raqamli filial
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label={t(language, 'auth.email')} required>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="siz@biznes.uz"
              />
            </Field>

            <Field label={t(language, 'auth.password')} required error={error ?? undefined}>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" fullWidth loading={submitting}>
              {t(language, 'auth.login')}
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-content-muted">
            Hisobingiz yo‘qmi?{' '}
            <Link href="/auth/register" className="font-medium text-brand hover:underline">
              {t(language, 'auth.register')}
            </Link>
          </p>
        </Card>

        {process.env.NODE_ENV !== 'production' && (
          <Card className="mt-4 p-4">
            <p className="text-xs font-medium text-content-muted">Demo hisoblar</p>
            <div className="mt-2 space-y-1">
              {[
                ['anor@bizbot.uz', 'Anor Cafe — restoran'],
                ['barber@bizbot.uz', 'Barber House — bron'],
                ['zebo@bizbot.uz', 'Zebo Beauty — salon'],
              ].map(([demoEmail, label]) => (
                <button
                  key={demoEmail}
                  type="button"
                  onClick={() => { setEmail(demoEmail!); setPassword('BizBotDemo2026'); }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-surface-sunken"
                >
                  <span className="font-mono text-content">{demoEmail}</span>
                  <span className="text-content-subtle">{label}</span>
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
