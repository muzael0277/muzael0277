import Link from 'next/link';
import { TEMPLATE_DEFINITIONS, MODULE_DEFINITIONS, AVAILABLE_MODULES } from '@bizbot/rbac';
import { formatMoney } from '@bizbot/shared';

const ADMIN = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'http://localhost:3001';

/**
 * The public site.
 *
 * Server-rendered for SEO, and the template and module lists are read from the same
 * definitions the product runs on — so the marketing page cannot promise a vertical or a
 * feature that does not exist.
 */
export default function LandingPage() {
  const templates = Object.values(TEMPLATE_DEFINITIONS).filter(
    (template) => template.key !== 'CUSTOM',
  );
  const modules = AVAILABLE_MODULES.map((key) => MODULE_DEFINITIONS[key])
    .filter((definition) => !definition.core)
    .slice(0, 12);

  return (
    <main>
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-fg">
              B
            </div>
            <span className="font-semibold">BizBot OS</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`${ADMIN}/auth/login`}
              className="rounded-lg px-4 py-2 text-sm text-content-muted hover:text-content"
            >
              Kirish
            </Link>
            <Link
              href={`${ADMIN}/auth/register`}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg transition hover:brightness-110"
            >
              Boshlash
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 rounded-full bg-brand-subtle px-3 py-1 text-sm font-medium text-brand">
            O‘zbekiston bizneslari uchun
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Telegram’da biznesingiz uchun raqamli filial
          </h1>
          <p className="mt-5 text-lg text-content-muted">
            Savdo, bron, buyurtma, mijozlar, to‘lovlar va biznes boshqaruvi — barchasi bitta
            platformada. Bir necha daqiqada ishga tushiring.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href={`${ADMIN}/auth/register`}
              className="rounded-lg bg-brand px-6 py-3 font-medium text-brand-fg transition hover:brightness-110"
            >
              Bepul boshlash
            </Link>
            <a
              href="#imkoniyatlar"
              className="rounded-lg border border-line px-6 py-3 font-medium transition hover:bg-surface-sunken"
            >
              Imkoniyatlar
            </a>
          </div>
          <p className="mt-4 text-sm text-content-subtle">
            Karta talab qilinmaydi · O‘zbek va rus tillarida · {formatMoney(0)}dan
          </p>
        </div>
      </section>

      <section className="border-y border-line bg-surface-sunken py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-2xl font-semibold">Qaysi biznes uchun?</h2>
          <p className="mt-2 text-content-muted">
            Bitta platforma — biznesingiz turiga qarab sozlanadi.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {templates.map((template) => (
              <div
                key={template.key}
                className="rounded-xl border border-line bg-surface-raised p-5"
              >
                <h3 className="font-medium">{template.label.uz}</h3>
                <p className="mt-1.5 text-sm text-content-muted">{template.description.uz}</p>
                <ul className="mt-3 space-y-1">
                  {template.examples.uz.slice(0, 4).map((example) => (
                    <li key={example} className="text-sm text-content-subtle">
                      · {example}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="imkoniyatlar" className="py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-2xl font-semibold">Kerakligini yoqing</h2>
          <p className="mt-2 text-content-muted">
            Har bir imkoniyat alohida yoqiladi. Keraksizi ko‘rinmaydi.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((module) => (
              <div key={module.key} className="rounded-xl border border-line p-5">
                <h3 className="font-medium">{module.label.uz}</h3>
                <p className="mt-1 text-sm text-content-muted">{module.description.uz}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-surface-sunken py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-2xl font-semibold">Qanday ishlaydi</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Ro‘yxatdan o‘ting', 'Bir necha savolga javob bering — tizim o‘zi sozlanadi.'],
              ['Botni ulang', 'BotFather’dan token oling va joylashtiring. Bot sizniki bo‘ladi.'],
              ['Mahsulot qo‘shing', 'Menyu yoki xizmatlar ro‘yxatini kiriting.'],
              ['Mijozlarni qabul qiling', 'Buyurtma, bron va to‘lovlar Telegram orqali keladi.'],
            ].map(([title, body], index) => (
              <div key={title}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-semibold text-brand-fg">
                  {index + 1}
                </div>
                <h3 className="mt-3 font-medium">{title}</h3>
                <p className="mt-1 text-sm text-content-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="text-2xl font-semibold">Bugun ishga tushiring</h2>
          <p className="mt-2 text-content-muted">
            Mijozlaringiz allaqachon Telegram’da. Ular bilan o‘z botingiz orqali ishlang.
          </p>
          <Link
            href={`${ADMIN}/auth/register`}
            className="mt-6 inline-block rounded-lg bg-brand px-6 py-3 font-medium text-brand-fg transition hover:brightness-110"
          >
            Bepul boshlash
          </Link>
        </div>
      </section>

      <footer className="border-t border-line py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 text-sm text-content-subtle">
          <span>© {new Date().getFullYear()} BizBot OS</span>
          <span>Toshkent, O‘zbekiston</span>
        </div>
      </footer>
    </main>
  );
}
