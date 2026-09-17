import { z } from 'zod';
import { dateOnlySchema, idSchema } from './primitives';

export const analyticsRangeSchema = z
  .object({
    preset: z
      .enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'custom'])
      .default('last30'),
    dateFrom: dateOnlySchema.optional(),
    dateTo: dateOnlySchema.optional(),
    branchId: idSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.preset === 'custom' && (!v.dateFrom || !v.dateTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateFrom'],
        message: 'Custom range requires dateFrom and dateTo',
      });
    }
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        message: 'dateTo must be on or after dateFrom',
      });
    }
  });
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export interface DashboardMetrics {
  revenue: { value: number; previous: number; changePercent: number };
  orders: { value: number; previous: number; changePercent: number };
  bookings: { value: number; previous: number; changePercent: number };
  customers: { total: number; new: number; returning: number };
  averageOrderValue: number;
  revenuePerCustomer: number;
  ordersByStatus: { status: string; count: number }[];
  paymentBreakdown: { method: string; count: number; amount: number }[];
  topProducts: { id: string; name: string; quantity: number; revenue: number }[];
  topServices: { id: string; name: string; count: number; revenue: number }[];
  topEmployees: { id: string; name: string; bookings: number; revenue: number }[];
  revenueTimeline: { date: string; revenue: number; orders: number }[];
  lowStock: { id: string; name: string; stockQuantity: number; threshold: number }[];
  bookingCancellationRate: number;
}

/**
 * Business health insights are derived from stored analytics — never invented.
 * Each insight names the metric and the window it came from so the owner can verify it.
 */
export interface BusinessInsight {
  key: string;
  severity: 'info' | 'warning' | 'critical' | 'positive';
  title: { uz: string; ru: string };
  body: { uz: string; ru: string };
  metric?: { name: string; value: number; comparedTo?: number };
  actionHref?: string;
}
