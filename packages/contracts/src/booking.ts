import { z } from 'zod';
import {
  idSchema,
  dateOnlySchema,
  paginationSchema,
  timeOfDaySchema,
  phoneSchema,
} from './primitives';

export const bookingStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);

export const availabilityQuerySchema = z.object({
  serviceId: idSchema,
  date: dateOnlySchema,
  branchId: idSchema.optional(),
  /** Omit to get availability across every resource that can perform the service. */
  resourceId: idSchema.optional(),
  employeeId: idSchema.optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const createBookingSchema = z.object({
  serviceId: idSchema,
  /** UTC instant. The client sends what the availability endpoint returned, verbatim. */
  startsAt: z.string().datetime(),
  resourceId: idSchema.optional(),
  employeeId: idSchema.optional(),
  branchId: idSchema.optional(),
  customerId: idSchema.optional(),
  customerPhone: phoneSchema.optional(),
  customerName: z.string().trim().max(128).optional(),
  comment: z.string().trim().max(500).optional(),
  customFields: z.record(z.string().max(64), z.unknown()).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const rescheduleBookingSchema = z.object({
  startsAt: z.string().datetime(),
  resourceId: idSchema.optional(),
  reason: z.string().trim().max(255).optional(),
});

export const updateBookingStatusSchema = z.object({
  status: bookingStatusSchema,
  comment: z.string().trim().max(255).optional(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(255).optional(),
});

export const listBookingsSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.union([bookingStatusSchema, z.array(bookingStatusSchema)]).optional(),
  resourceId: idSchema.optional(),
  employeeId: idSchema.optional(),
  branchId: idSchema.optional(),
  serviceId: idSchema.optional(),
  customerId: idSchema.optional(),
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  sortBy: z.enum(['startsAt', 'createdAt']).default('startsAt'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const createResourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['EMPLOYEE', 'ROOM', 'EQUIPMENT', 'TABLE', 'VEHICLE', 'GENERIC']).default('GENERIC'),
  employeeId: idSchema.nullable().optional(),
  branchId: idSchema.nullable().optional(),
  capacity: z.number().int().min(1).max(100).default(1),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
  isActive: z.boolean().default(true),
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

export const createTimeOffSchema = z
  .object({
    resourceId: idSchema,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    reason: z.string().trim().max(255).optional(),
  })
  .refine((v) => new Date(v.startsAt) < new Date(v.endsAt), {
    message: 'Tugash vaqti boshlanishdan keyin bo‘lishi kerak',
    path: ['endsAt'],
  });
