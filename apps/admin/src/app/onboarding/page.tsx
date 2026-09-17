'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, useToast, cn } from '@bizbot/ui';
import { MODULE_DEFINITIONS, type ModuleKey } from '@bizbot/rbac';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Template {
  key: string;
  label: { uz: string; ru: string };
  description: { uz: string; ru: string };
  icon: string;
  examples: { uz: string[]; ru: string[] };
  modules: string[];
}

/**
 * Onboarding.
 *
 * The owner answers business questions — do customers book, do you deliver, how many
 * branches — and the platform picks the template and modules. The word "module" never
 * appears until the review step, and even there it is phrased as what the business can
 * do (docs/architecture/05-modules-and-templates.md).
 */
export default function OnboardingPage() {
  const router = useRouter();
  const toast = useToast();
  const { language, reload, tenants } = useSession();

  const [step, setStep] = React.useState(0);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [answers, setAnswers] = React.useState({
    sellsProducts: false,
    takesBookings: false,
    servesFood: false,
    delivers: false,
    branchCount: 1,
    hasEmployeeSchedules: false,
    tracksStock: false,
  });
  const [recommendation, setRecommendation] = React.useState<{ template: Template; modules: ModuleKey[] } | null>(null);
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    api<Template[]>('/templates').then(setTemplates).catch(() => undefined);
  }, []);

  const questions: { key: keyof typeof answers; uz: string; ru: string }[] = [
    { key: 'sellsProducts', uz: 'Mahsulot sotasizmi?', ru: 'Продаёте товары?' },
    { key: 'takesBookings', uz: 'Mijozlar navbatga yoziladimi?', ru: 'Клиенты записываются?' },
    { key: 'servesFood', uz: 'Taom tayyorlaysizmi?', ru: 'Готовите еду?' },
    { key: 'delivers', uz: 'Yetkazib berasizmi?', ru: 'Доставляете?' },
    { key: 'hasEmployeeSchedules', uz: 'Xodimlaringiz jadval bo‘yicha ishlaydimi?', ru: 'Сотрудники работают по графику?' },
    { key: 'tracksStock', uz: 'Ombor qoldig‘ini hisoblaysizmi?', ru: 'Ведёте учёт склада?' },
  ];

  async function recommend() {
    try {
      const result = await api<{ template: Template; modules: ModuleKey[] }>('/onboarding/recommend', {
        method: 'POST', body: answers,
      });
      setRecommendation(result);
      setStep(2);
    } catch {
      toast.error('Tavsiya olishda xatolik');
    }
  }

  async function createBusiness() {
    setErrors({});
    if (name.trim().length < 2) {
      setErrors({ name: 'Biznes nomi kamida 2 ta belgidan iborat bo‘lishi kerak' });
      return;
    }

    setSubmitting(true);
    try {
      await api('/tenants', {
        method: 'POST',
        body: {
          name: name.trim(),
          templateKey: recommendation?.template.key ?? 'CUSTOM',
          phone: phone || undefined,
        },
      });
      await reload();
      toast.success('Biznesingiz yaratildi');
      router.replace('/');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fields = caught.fieldErrors;
        if (Object.keys(fields).length > 0) setErrors(fields);
        else toast.error(caught.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const steps = ['Biznes turi', 'Savollar', 'Tayyor'];

  return (
    <div className="min-h-screen bg-surface-sunken p-4 sm:p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Biznesingizni ishga tushiring</h1>
          <p className="mt-1 text-sm text-content-muted">
            Bir necha savol — qolganini o‘zimiz sozlaymiz.
          </p>
        </div>

        {/* Progress. Three steps, always visible, so the end is never a surprise. */}
        <div className="mb-6 flex gap-2">
          {steps.map((label, index) => (
            <div key={label} className="flex-1">
              <div className={cn('h-1 rounded-full transition', index <= step ? 'bg-brand' : 'bg-line')} />
              <p className={cn('mt-1.5 text-xs', index <= step ? 'text-brand' : 'text-content-subtle')}>{label}</p>
            </div>
          ))}
        </div>

        {step === 0 && (
          <Card className="p-6">
            <h2 className="font-medium">Qanday biznes yuritasiz?</h2>
            <p className="mt-1 text-sm text-content-muted">Aniq bo‘lmasa, savollar orqali topamiz.</p>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {templates.map((template) => (
                <button
                  key={template.key}
                  onClick={() => {
                    // Picking a template pre-fills the answers, so the questions confirm
                    // rather than interrogate.
                    setAnswers({
                      sellsProducts: template.modules.includes('CATALOG'),
                      takesBookings: template.modules.includes('BOOKING'),
                      servesFood: template.key === 'RESTAURANT',
                      delivers: template.modules.includes('DELIVERY'),
                      branchCount: 1,
                      hasEmployeeSchedules: template.modules.includes('EMPLOYEES'),
                      tracksStock: template.modules.includes('INVENTORY'),
                    });
                    setStep(1);
                  }}
                  className="rounded-lg border border-line bg-surface-raised p-4 text-left transition hover:border-brand hover:shadow-card"
                >
                  <p className="font-medium">{language === 'ru' ? template.label.ru : template.label.uz}</p>
                  <p className="mt-1 text-sm text-content-muted">
                    {language === 'ru' ? template.description.ru : template.description.uz}
                  </p>
                  <p className="mt-2 text-xs text-content-subtle">
                    {(language === 'ru' ? template.examples.ru : template.examples.uz).slice(0, 3).join(' · ')}
                  </p>
                </button>
              ))}
            </div>
          </Card>
        )}

        {step === 1 && (
          <Card className="p-6">
            <h2 className="font-medium">Biznesingiz haqida</h2>

            <div className="mt-4 space-y-2">
              {questions.map((question) => (
                <label
                  key={question.key}
                  className="flex cursor-pointer items-center justify-between rounded-lg border border-line px-4 py-3 transition hover:bg-surface-sunken"
                >
                  <span className="text-sm">{language === 'ru' ? question.ru : question.uz}</span>
                  <input
                    type="checkbox"
                    checked={Boolean(answers[question.key])}
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.key]: event.target.checked }))
                    }
                    className="h-5 w-5 rounded border-line text-brand focus:ring-brand/30"
                  />
                </label>
              ))}

              <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
                <span className="text-sm">Nechta filial?</span>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={answers.branchCount}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, branchCount: Math.max(1, Number(event.target.value)) }))
                  }
                  className="w-20 text-center"
                />
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <Button variant="secondary" onClick={() => setStep(0)}>Orqaga</Button>
              <Button onClick={recommend} fullWidth>Davom etish</Button>
            </div>
          </Card>
        )}

        {step === 2 && recommendation && (
          <Card className="p-6">
            <h2 className="font-medium">
              {language === 'ru' ? recommendation.template.label.ru : recommendation.template.label.uz}
            </h2>
            <p className="mt-1 text-sm text-content-muted">
              Javoblaringiz asosida quyidagi imkoniyatlar yoqiladi:
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {recommendation.modules.map((module) => {
                const definition = MODULE_DEFINITIONS[module];
                if (!definition) return null;
                return (
                  <span key={module} className="rounded-md bg-brand-subtle px-2 py-1 text-xs font-medium text-brand">
                    {language === 'ru' ? definition.label.ru : definition.label.uz}
                  </span>
                );
              })}
            </div>

            <div className="mt-5 space-y-4">
              <Field label="Biznes nomi" required error={errors.name}>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Anor Cafe"
                  autoFocus
                />
              </Field>

              <Field label="Telefon" hint="Mijozlar ko‘radigan raqam" error={errors.phone}>
                <Input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+998 90 123 45 67"
                />
              </Field>
            </div>

            <div className="mt-5 flex gap-2">
              <Button variant="secondary" onClick={() => setStep(1)}>Orqaga</Button>
              <Button onClick={createBusiness} loading={submitting} fullWidth>
                Biznesni yaratish
              </Button>
            </div>

            <p className="mt-3 text-center text-xs text-content-subtle">
              Keyinroq sozlamalardan istalgan imkoniyatni yoqib-o‘chirishingiz mumkin.
            </p>
          </Card>
        )}

        {tenants.length > 0 && (
          <p className="mt-5 text-center text-sm">
            <button onClick={() => router.replace('/')} className="text-content-muted hover:underline">
              Mavjud biznesga qaytish
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
