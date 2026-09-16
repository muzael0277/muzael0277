import { z } from 'zod';
import {
  idSchema, moneySchema, phoneSchema, paginationSchema, dateOnlySchema,
  percentageSchema, customFieldsSchema,
} from './primitives';

export const fulfillmentTypeSchema = z.enum(['DELIVERY', 'PICKUP', 'DINE_IN']);

export const orderStatusSchema = z.enum([
  'NEW', 'ACCEPTED', 'PREPARING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELLED',
]);

export const paymentMethodSchema = z.enum(['CASH', 'CLICK', 'PAYME', 'CARD_TERMINAL', 'TELEGRAM_STARS', 'MOCK']);

/**
 * Cart mutations carry selections only — never prices.
 * The server prices every line from the catalog at checkout (invariant I2).
 */
export const addCartItemSchema = z.object({
  productId: idSchema,
  variantId: idSchema.nullable().optional(),
  quantity: z.number().int().min(1).max(999),
  modifierOptionIds: z.array(idSchema).max(20).default([]),
  comment: z.string().trim().max(255).optional(),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0).max(999),
});

export const applyPromoSchema = z.object({ code: z.string().trim().min(2).max(32).toUpperCase() });

export const checkoutSchema = z.object({
  fulfillmentType: fulfillmentTypeSchema,
  branchId: idSchema.optional(),
  addressId: idSchema.optional(),
  address: z.object({
    label: z.string().trim().max(64).optional(),
    line1: z.string().trim().min(3).max(255),
    landmark: z.string().trim().max(255).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    saveForLater: z.boolean().default(true),
  }).optional(),
  phone: phoneSchema.optional(),
  paymentMethod: paymentMethodSchema,
  promoCode: z.string().trim().max(32).optional(),
  /** Bonus points to spend, capped server-side by loyaltySettings.maxRedeemPercent. */
  useLoyaltyAmount: moneySchema.default(0),
  comment: z.string().trim().max(500).optional(),
  scheduledFor: z.string().datetime().optional(),
}).superRefine((v, ctx) => {
  if (v.fulfillmentType === 'DELIVERY' && !v.addressId && !v.address) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'],
      message: 'Yetkazib berish uchun manzil kerak' });
  }
  if (v.fulfillmentType !== 'DELIVERY' && !v.branchId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchId'],
      message: 'Filialni tanlang' });
  }
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Staff-created order (phone order, walk-in). Same pricing path as the Mini App. */
export const createOrderSchema = z.object({
  customerId: idSchema.optional(),
  customerPhone: phoneSchema.optional(),
  customerName: z.string().trim().max(128).optional(),
  branchId: idSchema.optional(),
  fulfillmentType: fulfillmentTypeSchema,
  items: z.array(z.object({
    productId: idSchema,
    variantId: idSchema.nullable().optional(),
    quantity: z.number().int().min(1).max(999),
    modifierOptionIds: z.array(idSchema).max(20).default([]),
    comment: z.string().trim().max(255).optional(),
  })).min(1).max(100),
  paymentMethod: paymentMethodSchema,
  promoCode: z.string().trim().max(32).optional(),
  address: z.object({ line1: z.string().trim().min(3).max(255), landmark: z.string().max(255).optional() }).optional(),
  comment: z.string().trim().max(500).optional(),
  internalComment: z.string().trim().max(500).optional(),
}).refine((v) => v.customerId || v.customerPhone, {
  message: 'Mijoz yoki telefon raqam kerak', path: ['customerPhone'],
});

export const updateOrderStatusSchema = z.object({
  status: orderStatusSchema,
  comment: z.string().trim().max(255).optional(),
});

export const listOrdersSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.union([orderStatusSchema, z.array(orderStatusSchema)]).optional(),
  customerId: idSchema.optional(),
  branchId: idSchema.optional(),
  fulfillmentType: fulfillmentTypeSchema.optional(),
  paymentStatus: z.enum(['UNPAID', 'PENDING', 'PAID', 'REFUNDED']).optional(),
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  sortBy: z.enum(['createdAt', 'total', 'orderNumber']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const createPromoSchema = z.object({
  code: z.string().trim().min(2).max(32).toUpperCase()
    .regex(/^[A-Z0-9_-]+$/, 'Faqat lotin harflari, raqamlar, - va _'),
  type: z.enum(['PERCENTAGE', 'FIXED']),
  value: z.number().int().min(1).max(2_000_000_000),
  minOrderTotal: moneySchema.default(0),
  maxDiscount: moneySchema.nullable().optional(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(1000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().default(true),
  /** Open-ended rules for future promo types; validated per type on write. */
  rules: z.record(z.string(), z.unknown()).optional(),
}).superRefine((v, ctx) => {
  if (v.type === 'PERCENTAGE' && v.value > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Foiz 100 dan oshmasligi kerak' });
  }
  if (v.startsAt && v.endsAt && new Date(v.startsAt) >= new Date(v.endsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'Tugash sanasi boshlanishdan keyin bo‘lishi kerak' });
  }
});

export const adjustLoyaltySchema = z.object({
  customerId: idSchema,
  /** Signed: negative deducts. */
  amount: z.number().int().min(-100_000_000).max(100_000_000).refine((v) => v !== 0, 'Miqdor 0 bo‘lishi mumkin emas'),
  reason: z.string().trim().min(3).max(255),
});

export const createPaymentSchema = z.object({
  orderId: idSchema.optional(),
  bookingId: idSchema.optional(),
  method: paymentMethodSchema,
  returnUrl: z.string().url().max(2048).optional(),
}).refine((v) => v.orderId || v.bookingId, { message: 'orderId yoki bookingId kerak' });

export const refundPaymentSchema = z.object({
  amount: moneySchema.optional(),
  reason: z.string().trim().min(3).max(255),
});

export { percentageSchema, customFieldsSchema };
