import { formatMoney, formatUzPhone, resolveI18n, type CurrencyCode, type I18nValue, type Language } from '@bizbot/shared';

/** Display helpers shared by every admin screen, so formatting never drifts per page. */

export function money(amount: number | string | bigint | null | undefined, currency = 'UZS', language: Language = 'uz') {
  if (amount === null || amount === undefined) return '—';
  return formatMoney(typeof amount === 'string' ? Number(amount) : amount, currency as CurrencyCode, language);
}

export function phone(value: string | null | undefined) {
  return value ? formatUzPhone(value) : '—';
}

export function text(value: I18nValue | string | null | undefined, language: Language = 'uz') {
  return resolveI18n(value, language) || '—';
}

/** "17.09.2026, 14:30" in the tenant's timezone. */
export function dateTime(value: string | Date | null | undefined, timezone = 'Asia/Tashkent') {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function date(value: string | Date | null | undefined, timezone = 'Asia/Tashkent') {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(value));
}

/**
 * "2 soat oldin" — relative time reads faster than a timestamp in an activity list.
 *
 * Uzbek is written out rather than delegated to Intl.RelativeTimeFormat: browsers ship
 * incomplete CLDR data for `uz` and silently degrade to "-3 h", which is not a language
 * anyone speaks. Russian and English go through Intl, which handles them properly.
 */
const UZ_RELATIVE = {
  minute: { past: 'daqiqa oldin', future: 'daqiqadan keyin' },
  hour: { past: 'soat oldin', future: 'soatdan keyin' },
  day: { past: 'kun oldin', future: 'kundan keyin' },
} as const;

export function relative(value: string | Date | null | undefined, language: Language = 'uz') {
  if (!value) return '—';

  const diffMinutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  const unit: keyof typeof UZ_RELATIVE =
    Math.abs(diffMinutes) < 60 ? 'minute' : Math.abs(diffMinutes) < 1440 ? 'hour' : 'day';
  const amount =
    unit === 'minute' ? diffMinutes : unit === 'hour' ? Math.round(diffMinutes / 60) : Math.round(diffMinutes / 1440);

  if (language === 'uz') {
    if (unit === 'minute' && Math.abs(amount) < 1) return 'hozir';
    const phrase = UZ_RELATIVE[unit][amount < 0 ? 'past' : 'future'];
    return `${Math.abs(amount)} ${phrase}`;
  }

  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(amount, unit);
}

export const ORDER_STATUS_TONE = {
  NEW: 'info', ACCEPTED: 'brand', PREPARING: 'warning', READY: 'positive',
  DELIVERING: 'brand', COMPLETED: 'positive', CANCELLED: 'critical',
} as const;

export const BOOKING_STATUS_TONE = {
  PENDING: 'warning', CONFIRMED: 'info', ARRIVED: 'brand', IN_PROGRESS: 'brand',
  COMPLETED: 'positive', CANCELLED: 'critical', NO_SHOW: 'critical',
} as const;
