import { z } from 'zod';
import {
  idSchema,
  phoneSchema,
  emailSchema,
  languageSchema,
  paginationSchema,
  dateOnlySchema,
  customFieldsSchema,
} from './primitives';

export const createCustomerSchema = z.object({
  firstName: z.string().trim().min(1).max(64),
  lastName: z.string().trim().max(64).optional(),
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  language: languageSchema.default('uz'),
  birthDate: dateOnlySchema.optional(),
  source: z.enum(['TELEGRAM', 'MANUAL', 'IMPORT', 'POS', 'WEB']).default('MANUAL'),
  tagIds: z.array(idSchema).max(50).optional(),
  customFields: customFieldsSchema.optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial().omit({ source: true });

export const listCustomersSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  tagId: idSchema.optional(),
  segmentKey: z.string().trim().max(64).optional(),
  language: languageSchema.optional(),
  hasOrders: z.coerce.boolean().optional(),
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  sortBy: z
    .enum(['createdAt', 'lastActivityAt', 'totalSpent', 'orderCount', 'firstName'])
    .default('lastActivityAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(32),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366F1'),
});

export const createNoteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  isPinned: z.boolean().default(false),
});

/**
 * Segment filter tree. Stored as data so tenants can author their own segments later —
 * "VIP" and "inactive 30 days" are seeded rows, not code branches.
 */
export const segmentFilterSchema: z.ZodType<SegmentFilter> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(segmentFilterSchema).min(1).max(10) }),
    z.object({ any: z.array(segmentFilterSchema).min(1).max(10) }),
    z.object({
      field: z.enum([
        'totalSpent',
        'orderCount',
        'bookingCount',
        'loyaltyBalance',
        'lastActivityAt',
        'createdAt',
        'birthDate',
        'language',
        'source',
        'tag',
      ]),
      op: z.enum([
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'in',
        'daysAgoGt',
        'daysAgoLt',
        'monthDayEq',
      ]),
      value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number()])),
      ]),
    }),
  ]),
);

export type SegmentFilter =
  | { all: SegmentFilter[] }
  | { any: SegmentFilter[] }
  | { field: string; op: string; value: string | number | boolean | (string | number)[] };

export const createSegmentSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9_]+$/),
  name: z.object({
    uz: z.string().max(64),
    ru: z.string().max(64).optional(),
    en: z.string().max(64).optional(),
  }),
  filter: segmentFilterSchema,
});

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  attachments: z
    .array(z.object({ type: z.enum(['image', 'file']), url: z.string().url() }))
    .max(5)
    .optional(),
});

export const listConversationsSchema = paginationSchema.extend({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED']).optional(),
  assignedToId: idSchema.optional(),
  unassigned: z.coerce.boolean().optional(),
});
