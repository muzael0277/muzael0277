/**
 * Pure string helpers, safe in a browser bundle.
 *
 * Anything needing node:crypto lives in ./server instead: a shared package that drags a
 * Node built-in into the client build breaks the bundler, and "just polyfill it" ships
 * dead weight to a phone on mobile data.
 */

/**
 * Order numbers are per-tenant and per-day: "250916-0042".
 * Short enough to read aloud, sortable, and scoped so two tenants never collide.
 */
export function formatOrderNumber(date: Date, sequence: number): string {
  const yy = String(date.getUTCFullYear()).slice(2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}-${String(sequence).padStart(4, '0')}`;
}

/** Slugifies business names, transliterating Cyrillic and Uzbek Latin diacritics. */
export function slugify(input: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '',
    э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
    'ʻ': '', 'ʼ': '', '’': '', '‘': '',
  };
  return input
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
