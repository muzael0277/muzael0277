import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App initData verification.
 *
 * The client hands us a signed query string. We never trust the user object inside it
 * until the signature is checked — anyone can open a Mini App URL and edit the payload,
 * so skipping this is a complete authentication bypass
 * (docs/architecture/07-telegram.md).
 *
 * Pure and dependency-free so it can be unit-tested exhaustively.
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  allows_write_to_pm?: boolean;
}

export interface ParsedInitData {
  user?: TelegramUser;
  chat_instance?: string;
  chat_type?: string;
  start_param?: string;
  auth_date: number;
  query_id?: string;
  hash: string;
}

export type InitDataResult =
  | { ok: true; data: ParsedInitData }
  | { ok: false; reason: 'MALFORMED' | 'MISSING_HASH' | 'SIGNATURE_INVALID' | 'EXPIRED' };

/** Telegram's fixed key-derivation constant. */
const WEBAPP_CONSTANT = 'WebAppData';

/** initData older than this is rejected, limiting the window for a captured payload. */
export const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): InitDataResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'MISSING_HASH' };

  // The data-check string is every field except `hash`, sorted by key, joined with \n.
  // Sorting matters: Telegram signs a canonical form, so any other order fails.
  const pairs: string[] = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', WEBAPP_CONSTANT).update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time comparison: a byte-by-byte early exit leaks the correct prefix and
  // makes the signature forgeable with enough attempts.
  if (!constantTimeEquals(expected, hash)) return { ok: false, reason: 'SIGNATURE_INVALID' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'MALFORMED' };

  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (maxAge > 0 && nowSeconds - authDate > maxAge) return { ok: false, reason: 'EXPIRED' };

  let user: TelegramUser | undefined;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      user = JSON.parse(rawUser) as TelegramUser;
    } catch {
      return { ok: false, reason: 'MALFORMED' };
    }
  }

  return {
    ok: true,
    data: {
      user,
      chat_instance: params.get('chat_instance') ?? undefined,
      chat_type: params.get('chat_type') ?? undefined,
      start_param: params.get('start_param') ?? undefined,
      query_id: params.get('query_id') ?? undefined,
      auth_date: authDate,
      hash,
    },
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Builds an initData string for tests and local development.
 * Exported deliberately: without it, every test of the verifier would have to hand-craft
 * HMACs, and tests that are painful to write do not get written.
 */
export function signInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const entries = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', WEBAPP_CONSTANT).update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}
