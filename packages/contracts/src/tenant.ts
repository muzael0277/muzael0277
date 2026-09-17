import { z } from 'zod';
import { BUSINESS_TEMPLATES, MODULES } from '@bizbot/rbac';
import {
  slugSchema,
  phoneSchema,
  emailSchema,
  languageSchema,
  workingHoursSchema,
  moneySchema,
  idSchema,
  imageUrlSchema,
  timeOfDaySchema,
} from './primitives';

const templateKeySchema = z.enum(BUSINESS_TEMPLATES as unknown as [string, ...string[]]);
const moduleKeySchema = z.enum(MODULES as unknown as [string, ...string[]]);

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugSchema.optional(),
  templateKey: templateKeySchema,
  timezone: z.string().default('Asia/Tashkent'),
  currency: z.enum(['UZS', 'USD', 'RUB', 'KZT']).default('UZS'),
  defaultLanguage: languageSchema.default('uz'),
  phone: phoneSchema.optional(),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  logoUrl: imageUrlSchema.nullable().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  timezone: z.string().optional(),
  defaultLanguage: languageSchema.optional(),
});

export const updateTenantSettingsSchema = z.object({
  phone: phoneSchema.optional(),
  email: emailSchema.nullable().optional(),
  website: z.string().url().max(255).nullable().optional(),
  instagram: z.string().max(64).nullable().optional(),
  telegramChannel: z.string().max(64).nullable().optional(),
  description: z
    .object({
      uz: z.string().max(2000).optional(),
      ru: z.string().max(2000).optional(),
      en: z.string().max(2000).optional(),
    })
    .optional(),
  workingHours: workingHoursSchema.optional(),
  deliverySettings: z
    .object({
      enabled: z.boolean(),
      flatFee: moneySchema,
      freeAbove: moneySchema.nullable(),
      minOrderTotal: moneySchema,
      zones: z
        .array(z.object({ name: z.string().max(64), fee: moneySchema }))
        .max(50)
        .optional(),
      estimatedMinutes: z.number().int().min(0).max(600).optional(),
    })
    .optional(),
  bookingSettings: z
    .object({
      slotStepMinutes: z.number().int().min(5).max(120),
      minLeadTimeMinutes: z.number().int().min(0).max(10080),
      maxAdvanceDays: z.number().int().min(1).max(365),
      autoConfirm: z.boolean(),
      requirePrepayment: z.boolean().default(false),
      cancellationDeadlineMinutes: z.number().int().min(0).max(10080).default(120),
      reminderOffsetsMinutes: z.array(z.number().int().min(5).max(20160)).max(4),
    })
    .optional(),
  loyaltySettings: z
    .object({
      enabled: z.boolean(),
      type: z.enum(['CASHBACK', 'POINTS']),
      /** Percentage of order total credited back. */
      rate: z.number().min(0).max(50),
      minOrderTotal: moneySchema.default(0),
      /** Maximum share of an order that bonuses may cover. */
      maxRedeemPercent: z.number().min(0).max(100).default(50),
      expiryDays: z.number().int().min(0).max(3650).nullable().default(null),
    })
    .optional(),
});

export const setModulesSchema = z.object({
  modules: z.array(moduleKeySchema).min(1).max(MODULES.length),
});

export const toggleModuleSchema = z.object({
  module: moduleKeySchema,
  enabled: z.boolean(),
});

export const onboardingAnswersSchema = z.object({
  sellsProducts: z.boolean(),
  takesBookings: z.boolean(),
  servesFood: z.boolean(),
  delivers: z.boolean(),
  branchCount: z.number().int().min(1).max(500),
  hasEmployeeSchedules: z.boolean(),
  tracksStock: z.boolean(),
});

export const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().max(255).optional(),
  phone: phoneSchema.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  workingHours: workingHoursSchema.optional(),
  isDefault: z.boolean().default(false),
});

export const createEmployeeSchema = z.object({
  firstName: z.string().trim().min(1).max(64),
  lastName: z.string().trim().max(64).optional(),
  position: z.string().trim().max(64).optional(),
  phone: phoneSchema.optional(),
  branchId: idSchema.optional(),
  avatarUrl: imageUrlSchema.nullable().optional(),
  serviceIds: z.array(idSchema).max(200).optional(),
  schedule: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        start: timeOfDaySchema,
        end: timeOfDaySchema,
      }),
    )
    .max(21)
    .optional(),
});
