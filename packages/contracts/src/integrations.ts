import { z } from 'zod';
import { idSchema } from './primitives';

export const connectTelegramBotSchema = z.object({
  /** BotFather token. Stored encrypted; never returned to any client. */
  botToken: z
    .string()
    .trim()
    .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/, 'Bot token formati noto‘g‘ri'),
});

export const integrationTypeSchema = z.enum([
  'PAYMENT',
  'SMS',
  'EMAIL',
  'DELIVERY',
  'ACCOUNTING',
  'CRM',
  'ANALYTICS',
  'AI',
  'POS',
  'OTHER',
]);

export const upsertIntegrationSchema = z.object({
  type: integrationTypeSchema,
  provider: z.string().trim().min(2).max(32),
  /** Non-sensitive settings, safe to return to the admin UI. */
  config: z.record(z.string().max(64), z.unknown()).default({}),
  /** Credentials. Write-only: encrypted on receipt, never echoed back. */
  secrets: z.record(z.string().max(64), z.string().max(2048)).optional(),
  isEnabled: z.boolean().default(true),
});

export const testIntegrationSchema = z.object({ integrationId: idSchema });

export const createWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'Faqat HTTPS manzil'),
  events: z.array(z.string().max(64)).min(1).max(50),
  isActive: z.boolean().default(true),
});

export const uploadIntentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  purpose: z.enum(['LOGO', 'PRODUCT', 'SERVICE', 'AVATAR', 'CATEGORY']),
});
