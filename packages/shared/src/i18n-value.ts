/**
 * Customer-facing names and descriptions are stored as { uz, ru, en } maps.
 * Admin-only strings stay plain. See docs/architecture/01-domain-model.md.
 */

export type Language = 'uz' | 'ru' | 'en';
export const LANGUAGES: readonly Language[] = ['uz', 'ru', 'en'];
export const DEFAULT_LANGUAGE: Language = 'uz';

export type I18nValue = Partial<Record<Language, string>>;

/**
 * Resolves a translated value with a fallback chain, so a missing Russian translation
 * shows the Uzbek name rather than an empty cell.
 */
export function resolveI18n(
  value: I18nValue | string | null | undefined,
  language: Language = DEFAULT_LANGUAGE,
  fallback: readonly Language[] = LANGUAGES,
): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;

  const direct = value[language];
  if (direct && direct.trim() !== '') return direct;

  for (const lang of fallback) {
    const candidate = value[lang];
    if (candidate && candidate.trim() !== '') return candidate;
  }
  return '';
}

export function isI18nValue(value: unknown): value is I18nValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([k, v]) => LANGUAGES.includes(k as Language) && (v === undefined || typeof v === 'string'),
  );
}

/** Builds an I18nValue from a single string, used when seeding or importing. */
export function i18n(uz: string, ru?: string, en?: string): I18nValue {
  const out: I18nValue = { uz };
  if (ru) out.ru = ru;
  if (en) out.en = en;
  return out;
}
