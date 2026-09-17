import { z } from 'zod';
import {
  i18nTextSchema,
  i18nLongTextSchema,
  moneySchema,
  idSchema,
  imageUrlSchema,
  paginationSchema,
  customFieldsSchema,
} from './primitives';

export const createCategorySchema = z.object({
  name: i18nTextSchema,
  parentId: idSchema.nullable().optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export const createProductSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nLongTextSchema.optional(),
    categoryId: idSchema.nullable().optional(),
    sku: z.string().trim().max(64).optional(),
    barcode: z.string().trim().max(64).optional(),
    price: moneySchema,
    oldPrice: moneySchema.nullable().optional(),
    costPrice: moneySchema.nullable().optional(),
    images: z.array(imageUrlSchema).max(10).default([]),
    isActive: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    trackInventory: z.boolean().default(false),
    stockQuantity: z.number().int().min(0).max(1_000_000).default(0),
    lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    modifierGroupIds: z.array(idSchema).max(20).optional(),
    customFields: customFieldsSchema.optional(),
  })
  .refine((v) => v.oldPrice == null || v.oldPrice > v.price, {
    message: 'Eski narx joriy narxdan katta bo‘lishi kerak',
    path: ['oldPrice'],
  });

export const updateProductSchema = createProductSchema.innerType().partial();

export const createVariantSchema = z.object({
  name: i18nTextSchema,
  sku: z.string().trim().max(64).optional(),
  /** Delta against the product price, so a base price change flows through. */
  priceModifier: z.number().int().min(-2_000_000_000).max(2_000_000_000).default(0),
  stockQuantity: z.number().int().min(0).max(1_000_000).default(0),
  attributes: z.record(z.string().max(32), z.string().max(64)).optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

export const createModifierGroupSchema = z
  .object({
    name: i18nTextSchema,
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    sortOrder: z.number().int().min(0).max(999).default(0),
    options: z
      .array(
        z.object({
          name: i18nTextSchema,
          price: moneySchema.default(0),
          isDefault: z.boolean().default(false),
          isActive: z.boolean().default(true),
          sortOrder: z.number().int().min(0).max(999).default(0),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine((v) => v.maxSelect >= v.minSelect, {
    message: 'Maksimal tanlov minimaldan kam bo‘lmasligi kerak',
    path: ['maxSelect'],
  });

export const listProductsSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  categoryId: idSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  lowStock: z.coerce.boolean().optional(),
  sortBy: z.enum(['name', 'price', 'createdAt', 'sortOrder', 'stockQuantity']).default('sortOrder'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const createServiceSchema = z.object({
  name: i18nTextSchema,
  description: i18nLongTextSchema.optional(),
  categoryId: idSchema.nullable().optional(),
  price: moneySchema,
  /** Service duration in minutes; drives the booking slot length. */
  durationMinutes: z.number().int().min(5).max(1440),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
  imageUrl: imageUrlSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  employeeIds: z.array(idSchema).max(200).optional(),
  customFields: customFieldsSchema.optional(),
});

export const updateServiceSchema = createServiceSchema.partial();

export const adjustStockSchema = z.object({
  variantId: idSchema.nullable().optional(),
  productId: idSchema,
  /** Signed: negative writes stock off. */
  quantity: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Miqdor 0 bo‘lishi mumkin emas'),
  type: z.enum(['PURCHASE', 'RETURN', 'ADJUSTMENT', 'WRITE_OFF']),
  reason: z.string().trim().max(255).optional(),
  unitCost: moneySchema.optional(),
});
