'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, useToast } from '@bizbot/ui';
import { registerSchema } from '@bizbot/contracts';
import { t } from '@bizbot/i18n';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function RegisterPage() {
  const router = useRouter();
  const toast = useToast();
  const { language, reload } = useSession();

  const [form, setForm] = React.useState({ firstName: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    // The same zod schema the API validates with, so the first round-trip is not spent
    // on a mistake the browser could have caught.
    const parsed = registerSchema.safeParse({
      ...form,
      phone: form.phone || undefined,
      language,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
      ));
      return;
    }

    setSubmitting(true);
    try {
      const result = await api<{ accessToken: string }>('/auth/register', {
        method: 'POST', body: parsed.data,
      });
      setAccessToken(result.accessToken);
      await reload();
      router.replace('/onboarding');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fields = caught.fieldErrors;
        if (Object.keys(fields).length > 0) setErrors(fields);
        else toast.error(caught.message);
      } else {
        toast.error(t(language, 'errors.INTERNAL'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-semibold">Ro‘yxatdan o‘tish</h1>
        <p className="mb-6 text-center text-sm text-content-muted">
          Bir necha daqiqada biznesingizni ishga tushiring
        </p>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Ismingiz" required error={errors.firstName}>
              <Input value={form.firstName} onChange={update('firstName')} autoComplete="given-name" required />
            </Field>

            <Field label={t(language, 'auth.email')} required error={errors.email}>
              <Input type="email" value={form.email} onChange={update('email')} autoComplete="email" required />
            </Field>

            <Field label="Telefon" hint="+998 90 123 45 67" error={errors.phone}>
              <Input type="tel" value={form.phone} onChange={update('phone')} autoComplete="tel" placeholder="+998 90 123 45 67" />
            </Field>

            <Field
              label={t(language, 'auth.password')}
              required
              hint="Kamida 10 ta belgi"
              error={errors.password}
            >
              <Input type="password" value={form.password} onChange={update('password')} autoComplete="new-password" required />
            </Field>

            <Button type="submit" fullWidth loading={submitting}>Davom etish</Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-sm text-content-muted">
          Hisobingiz bormi?{' '}
          <Link href="/auth/login" className="font-medium text-brand hover:underline">
            {t(language, 'auth.login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
