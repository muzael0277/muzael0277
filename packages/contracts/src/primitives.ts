import { z } from 'zod';
import { isValidUzPhone, parseUzPhone, LANGUAGES } from '@bizbot/shared';

/** Shared leaf schemas. Defined once so validation never drifts between endpoints. */

export const idSchema = z.string().uuid();

export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug may contain lowercase letters, digits and hyphens');

export const languageSchema = z
  .enum(LANGUAGES as unknown as [string, ...string[]])
  .pipe(z.custom<(typeof LANGUAGES)[number]>());

/** Translated text. At least one language must be present and non-empty. */
export const i18nTextSchema = z
  .object({
    uz: z.string().trim().min(1).max(500).optional(),
    ru: z.string().trim().min(1).max(500).optional(),
    en: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => Object.values(v).some((s) => s && s.length > 0), {
    message: 'At least one language is required',
  });

export const i18nLongTextSchema = z.object({
  uz: z.string().trim().max(5000).optional(),
  ru: z.string().trim().max(5000).optional(),
  en: z.string().trim().max(5000).optional(),
});

/** Accepts any Uzbek input format and normalizes to E.164 without "+". */
export const phoneSchema = z
  .string()
  .trim()
  .refine(isValidUzPhone, 'Telefon raqam noto‘g‘ri. Masalan: +998 90 123 45 67')
  .transform((v) => parseUzPhone(v)!.e164);

export const emailSchema = z.string().trim().toLowerCase().email().max(255);

/**
 * Passwords: length beats composition rules for real-world strength, and composition
 * rules push people toward "Password1!". 10 characters minimum, no character classes
 * mandated, but obvious sequences rejected.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Parol kamida 10 ta belgidan iborat bo‘lishi kerak')
  .max(128)
  .refine((v) => !/^(.)\1+$/.test(v), 'Parol juda oddiy')
  .refine(
    (v) => !['1234567890', 'qwertyuiop', 'password12'].includes(v.toLowerCase()),
    'Parol juda oddiy',
  );

/** Money in minor units. Never negative for prices; never fractional. */
export const moneySchema = z.number().int().min(0).max(2_000_000_000);
export const signedMoneySchema = z.number().int().min(-2_000_000_000).max(2_000_000_000);

export const percentageSchema = z.number().min(0).max(100);

export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Vaqt HH:mm formatida bo‘lishi kerak');

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD formatida bo‘lishi kerak');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const timeRangeSchema = z
  .object({ start: timeOfDaySchema, end: timeOfDaySchema })
  .refine((v) => v.start < v.end, {
    message: 'Boshlanish vaqti tugash vaqtidan oldin bo‘lishi kerak',
  });

/** Working hours keyed by weekday 0..6 (0 = Sunday). An empty array means closed. */
export const workingHoursSchema = z.record(
  z.enum(['0', '1', '2', '3', '4', '5', '6']),
  z.array(timeRangeSchema).max(3),
);

export const customFieldsSchema = z.record(z.string().max(64), z.unknown());

export const imageUrlSchema = z.string().url().max(2048);
