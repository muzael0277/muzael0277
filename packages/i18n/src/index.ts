import type { Language } from '@bizbot/shared';
import { uz, type Dictionary } from './locales/uz';
import { ru } from './locales/ru';
import { en } from './locales/en';

export type { Dictionary };
export { uz, ru, en };

export const DICTIONARIES: Record<Language, Dictionary> = { uz, ru, en };

export function getDictionary(language: Language): Dictionary {
  return DICTIONARIES[language] ?? uz;
}

type Path = string;

function lookup(dict: unknown, path: Path): string | undefined {
  const value = path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, dict);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Translates a dotted key with {{variable}} interpolation.
 *
 * Falls back to Uzbek and then to the key itself, so a missing translation shows
 * something meaningful rather than an empty string — and is visible in QA.
 */
export function t(language: Language, key: Path, vars?: Record<string, string | number>): string {
  const template = lookup(getDictionary(language), key) ?? lookup(uz, key) ?? key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}

/** Bound translator, so call sites do not repeat the language. */
export function createTranslator(language: Language) {
  return (key: Path, vars?: Record<string, string | number>) => t(language, key, vars);
}

/** Maps a Telegram language_code ("uz", "ru-RU", "en-US") to a supported language. */
export function languageFromTelegram(code: string | undefined | null): Language {
  if (!code) return 'uz';
  const base = code.toLowerCase().split('-')[0];
  if (base === 'ru') return 'ru';
  if (base === 'en') return 'en';
  return 'uz';
}
