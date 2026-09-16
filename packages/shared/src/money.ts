/**
 * Money.
 *
 * Every monetary value in BizBot OS is an integer in the currency's minor unit.
 * UZS has exponent 0 (tiyin is obsolete in practice), so 35000 === 35 000 so'm.
 * See docs/adr/0006-money-as-integer-minor-units.md.
 *
 * Never use a float for money. Never format an amount outside this module.
 */

export type CurrencyCode = 'UZS' | 'USD' | 'RUB' | 'EUR' | 'KZT';

export interface CurrencyMeta {
  code: CurrencyCode;
  /** Number of decimal places the currency is stored with. */
  exponent: number;
  symbol: string;
  /** Symbol placement relative to the number. */
  position: 'prefix' | 'suffix';
}

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyMeta>> = {
  UZS: { code: 'UZS', exponent: 0, symbol: "so'm", position: 'suffix' },
  USD: { code: 'USD', exponent: 2, symbol: '$', position: 'prefix' },
  RUB: { code: 'RUB', exponent: 2, symbol: '₽', position: 'suffix' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€', position: 'prefix' },
  KZT: { code: 'KZT', exponent: 2, symbol: '₸', position: 'suffix' },
};

export const DEFAULT_CURRENCY: CurrencyCode = 'UZS';

export function currencyMeta(code: CurrencyCode): CurrencyMeta {
  const meta = CURRENCIES[code];
  if (!meta) throw new Error(`Unknown currency: ${code}`);
  return meta;
}

/**
 * Formats a minor-unit amount for display.
 *
 *   formatMoney(150000)              -> "150 000 so'm"
 *   formatMoney(150000, 'UZS', 'ru') -> "150 000 сум"
 *   formatMoney(1999, 'USD')         -> "$19.99"
 *
 * The thousands separator is a non-breaking space, which is the Uzbek and Russian
 * convention and prevents prices from wrapping mid-number in narrow Mini App layouts.
 */
export function formatMoney(
  amount: number | bigint,
  code: CurrencyCode = DEFAULT_CURRENCY,
  locale: 'uz' | 'ru' | 'en' = 'uz',
): string {
  const meta = currencyMeta(code);
  const negative = amount < 0;
  const abs = negative ? -BigInt(amount) : BigInt(amount);

  const divisor = 10n ** BigInt(meta.exponent);
  const whole = abs / divisor;
  const fraction = abs % divisor;

  let text = groupDigits(whole.toString());
  if (meta.exponent > 0) {
    text += '.' + fraction.toString().padStart(meta.exponent, '0');
  }
  if (negative) text = '−' + text;

  const symbol = code === 'UZS' && locale === 'ru' ? 'сум' : meta.symbol;
  return meta.position === 'prefix' ? `${symbol}${text}` : `${text} ${symbol}`;
}

/** Formats without the currency symbol — for inputs and tables with a currency header. */
export function formatAmount(amount: number | bigint, code: CurrencyCode = DEFAULT_CURRENCY): string {
  const meta = currencyMeta(code);
  const abs = amount < 0 ? -BigInt(amount) : BigInt(amount);
  const divisor = 10n ** BigInt(meta.exponent);
  let text = groupDigits((abs / divisor).toString());
  if (meta.exponent > 0) text += '.' + (abs % divisor).toString().padStart(meta.exponent, '0');
  return amount < 0 ? '−' + text : text;
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Parses user input into minor units.
 *
 * Separators are genuinely ambiguous across the locales we serve: an Uzbek or Russian
 * speaker writes "19,99" for a decimal, while the same person writes "150,000" meaning
 * one hundred fifty thousand. We disambiguate structurally rather than by locale:
 *
 *   "150 000" / "150,000" / "1.500.000"  -> grouped thousands, no fraction
 *   "19.99"   / "19,99"                  -> decimal fraction
 *
 * A fraction finer than the currency's minor unit is truncated, never rounded up — for
 * prices, erring downward is the safe direction.
 *
 * Returns null on invalid input so callers must handle it rather than storing a silent 0.
 */
export function parseMoney(input: string, code: CurrencyCode = DEFAULT_CURRENCY): number | null {
  const meta = currencyMeta(code);
  const cleaned = input.replace(/[\s\u00A0']/g, '');
  if (cleaned === '') return null;

  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  if (body === '') return null;

  let whole: string;
  let fraction: string;

  // "1,234" / "12.345.678": every separator is followed by exactly three digits and the
  // number does not start with 0, so these can only be thousands separators.
  const grouped = /^\d{1,3}([.,]\d{3})+$/.test(body) && !body.startsWith('0');

  if (grouped) {
    whole = body.replace(/[.,]/g, '');
    fraction = '';
  } else {
    const normalized = body.replace(/,/g, '.');
    if (!/^\d*\.?\d*$/.test(normalized)) return null;
    const [w = '', f = ''] = normalized.split('.');
    if (w === '' && f === '') return null;
    whole = w || '0';
    fraction = f;
  }

  const minorFraction = fraction.slice(0, meta.exponent).padEnd(meta.exponent, '0');
  const value = Number(whole + minorFraction);
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

/**
 * Applies a percentage discount, rounding half up.
 * percent is in basis-point-free form: 15 means 15%.
 */
export function applyPercentage(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}

/**
 * Distributes a total across weighted buckets so the parts always sum back to the total.
 *
 * Used to spread an order-level discount over its line items: naive per-line rounding
 * loses or invents so'm, and then the order total stops matching the sum of its lines.
 * Largest-remainder method — deterministic, and the remainder goes to the largest
 * weights first.
 */
export function distributeProportionally(total: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0 || total === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / weightSum);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    const entry = order[k];
    if (!entry) break;
    result[entry.i] = (result[entry.i] ?? 0) + 1;
    remainder--;
  }
  return result;
}

/** Sums minor-unit amounts as BigInt — for lifetime accumulators that can exceed Int32. */
export function sumBig(amounts: readonly (number | bigint)[]): bigint {
  return amounts.reduce<bigint>((acc, a) => acc + BigInt(a), 0n);
}
