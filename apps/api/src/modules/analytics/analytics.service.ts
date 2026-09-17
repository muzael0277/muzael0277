import { Injectable } from '@nestjs/common';
import { Prisma, tenantContext } from '@bizbot/database';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { resolveI18n, type Language } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';

/**
 * Analytics.
 *
 * Every number here is computed from stored facts. Nothing is estimated, and the
 * insights in `businessHealth` are derived from the same queries that produce the
 * dashboard — an "insight" a business owner cannot verify against their own numbers is
 * worse than no insight.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(range: { preset?: string; dateFrom?: string; dateTo?: string; branchId?: string }, language: Language = 'uz') {
    const { from, to, previousFrom, previousTo } = resolveRange(range);
    const branchFilter = range.branchId ? { branchId: range.branchId } : {};

    const paidOrders: Prisma.OrderWhereInput = {
      ...branchFilter,
      status: { notIn: ['CANCELLED'] },
      createdAt: { gte: from, lte: to },
    };
    const previousPaidOrders: Prisma.OrderWhereInput = {
      ...branchFilter,
      status: { notIn: ['CANCELLED'] },
      createdAt: { gte: previousFrom, lte: previousTo },
    };

    const [
      current, previous, bookingCount, previousBookingCount,
      newCustomers, totalCustomers, statusBreakdown, paymentBreakdown,
      topProducts, topServices, lowStock, cancelledBookings, allBookings,
    ] = await Promise.all([
      this.prisma.client.order.aggregate({ where: paidOrders, _sum: { total: true }, _count: true }),
      this.prisma.client.order.aggregate({ where: previousPaidOrders, _sum: { total: true }, _count: true }),
      this.prisma.client.booking.count({
        where: { startsAt: { gte: from, lte: to }, status: { notIn: ['CANCELLED'] }, ...branchFilter },
      }),
      this.prisma.client.booking.count({
        where: { startsAt: { gte: previousFrom, lte: previousTo }, status: { notIn: ['CANCELLED'] }, ...branchFilter },
      }),
      this.prisma.client.customer.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.client.customer.count(),
      this.prisma.client.order.groupBy({
        by: ['status'], where: { createdAt: { gte: from, lte: to }, ...branchFilter }, _count: true,
      }),
      this.prisma.client.order.groupBy({
        by: ['paymentMethod'], where: paidOrders, _count: true, _sum: { total: true },
      }),
      this.topProducts(from, to, range.branchId, language),
      this.topServices(from, to, language),
      this.prisma.client.product.findMany({
        where: { trackInventory: true, lowStockThreshold: { not: null }, archivedAt: null },
        select: { id: true, name: true, stockQuantity: true, lowStockThreshold: true },
        take: 200,
      }),
      this.prisma.client.booking.count({ where: { startsAt: { gte: from, lte: to }, status: 'CANCELLED' } }),
      this.prisma.client.booking.count({ where: { startsAt: { gte: from, lte: to } } }),
    ]);

    const revenue = Number(current._sum.total ?? 0);
    const previousRevenue = Number(previous._sum.total ?? 0);
    const orderCount = current._count;

    const returningCustomers = await this.prisma.client.customer.count({
      where: { orderCount: { gte: 2 } },
    });

    return {
      range: { from, to, previousFrom, previousTo },
      revenue: { value: revenue, previous: previousRevenue, changePercent: percentChange(revenue, previousRevenue) },
      orders: { value: orderCount, previous: previous._count, changePercent: percentChange(orderCount, previous._count) },
      bookings: { value: bookingCount, previous: previousBookingCount, changePercent: percentChange(bookingCount, previousBookingCount) },
      customers: { total: totalCustomers, new: newCustomers, returning: returningCustomers },
      averageOrderValue: orderCount > 0 ? Math.round(revenue / orderCount) : 0,
      revenuePerCustomer: totalCustomers > 0 ? Math.round(revenue / totalCustomers) : 0,
      ordersByStatus: statusBreakdown.map((s) => ({ status: s.status, count: s._count })),
      paymentBreakdown: paymentBreakdown.map((p) => ({
        method: p.paymentMethod, count: p._count, amount: Number(p._sum.total ?? 0),
      })),
      topProducts,
      topServices,
      lowStock: lowStock
        .filter((p) => p.lowStockThreshold !== null && p.stockQuantity <= p.lowStockThreshold)
        .map((p) => ({
          id: p.id, name: resolveI18n(p.name as never, language),
          stockQuantity: p.stockQuantity, threshold: p.lowStockThreshold!,
        })),
      bookingCancellationRate: allBookings > 0 ? Math.round((cancelledBookings / allBookings) * 100) : 0,
      revenueTimeline: await this.revenueTimeline(from, to, range.branchId),
    };
  }

  /**
   * Actionable observations derived from the dashboard's own numbers.
   * Each carries the metric it came from, so an owner can check it.
   */
  async businessHealth(language: Language = 'uz') {
    const metrics = await this.dashboard({ preset: 'last7' }, language);
    const insights: {
      key: string; severity: 'info' | 'warning' | 'critical' | 'positive';
      title: { uz: string; ru: string }; body: { uz: string; ru: string };
      metric?: { name: string; value: number; comparedTo?: number };
    }[] = [];

    if (metrics.revenue.previous > 0 && metrics.revenue.changePercent <= -15) {
      insights.push({
        key: 'revenue_down',
        severity: 'warning',
        title: { uz: 'Daromad kamaydi', ru: 'Выручка снизилась' },
        body: {
          uz: `Oxirgi 7 kunda daromad avvalgi haftaga nisbatan ${Math.abs(metrics.revenue.changePercent)}% kamaydi.`,
          ru: `За последние 7 дней выручка снизилась на ${Math.abs(metrics.revenue.changePercent)}% по сравнению с прошлой неделей.`,
        },
        metric: { name: 'revenue', value: metrics.revenue.value, comparedTo: metrics.revenue.previous },
      });
    }

    if (metrics.revenue.changePercent >= 20) {
      insights.push({
        key: 'revenue_up',
        severity: 'positive',
        title: { uz: 'Daromad o‘sdi', ru: 'Выручка выросла' },
        body: {
          uz: `Oxirgi 7 kunda daromad ${metrics.revenue.changePercent}% ga oshdi.`,
          ru: `За последние 7 дней выручка выросла на ${metrics.revenue.changePercent}%.`,
        },
        metric: { name: 'revenue', value: metrics.revenue.value, comparedTo: metrics.revenue.previous },
      });
    }

    if (metrics.lowStock.length > 0) {
      insights.push({
        key: 'low_stock',
        severity: metrics.lowStock.length >= 5 ? 'critical' : 'warning',
        title: { uz: 'Ombor tugayapti', ru: 'Заканчивается товар' },
        body: {
          uz: `${metrics.lowStock.length} ta mahsulot tugash arafasida: ${metrics.lowStock.slice(0, 3).map((p) => p.name).join(', ')}.`,
          ru: `${metrics.lowStock.length} товаров заканчиваются: ${metrics.lowStock.slice(0, 3).map((p) => p.name).join(', ')}.`,
        },
        metric: { name: 'lowStockCount', value: metrics.lowStock.length },
      });
    }

    const inactive = await this.prisma.client.customer.count({
      where: { lastActivityAt: { lt: new Date(Date.now() - 45 * 86_400_000) }, orderCount: { gt: 0 } },
    });
    if (inactive >= 5) {
      insights.push({
        key: 'inactive_customers',
        severity: 'info',
        title: { uz: 'Qaytmagan mijozlar', ru: 'Клиенты не возвращаются' },
        body: {
          uz: `${inactive} ta mijoz 45 kundan beri qaytmadi. Ularga aksiya yuboring.`,
          ru: `${inactive} клиентов не возвращались 45 дней. Отправьте им акцию.`,
        },
        metric: { name: 'inactiveCustomers', value: inactive },
      });
    }

    if (metrics.bookingCancellationRate >= 20) {
      insights.push({
        key: 'high_cancellation',
        severity: 'warning',
        title: { uz: 'Bekor qilishlar ko‘p', ru: 'Много отмен' },
        body: {
          uz: `Bronlarning ${metrics.bookingCancellationRate}% i bekor qilinmoqda. Eslatma vaqtini o‘zgartirib ko‘ring.`,
          ru: `${metrics.bookingCancellationRate}% записей отменяется. Попробуйте изменить время напоминаний.`,
        },
        metric: { name: 'bookingCancellationRate', value: metrics.bookingCancellationRate },
      });
    }

    const peak = await this.peakBookingHour();
    if (peak) {
      insights.push({
        key: 'peak_hour',
        severity: 'info',
        title: { uz: 'Eng band vaqt', ru: 'Самое загруженное время' },
        body: {
          uz: `Eng ko‘p bron ${peak.hour}:00–${peak.hour + 1}:00 oralig‘ida (${peak.count} ta).`,
          ru: `Больше всего записей с ${peak.hour}:00 до ${peak.hour + 1}:00 (${peak.count}).`,
        },
        metric: { name: 'peakHourBookings', value: peak.count },
      });
    }

    return insights;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async topProducts(from: Date, to: Date, branchId: string | undefined, language: Language) {
    const grouped = await this.prisma.client.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: { createdAt: { gte: from, lte: to }, status: { notIn: ['CANCELLED'] }, ...(branchId ? { branchId } : {}) },
        productId: { not: null },
      },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 10,
    });

    const products = await this.prisma.client.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId!).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return grouped.map((g) => ({
      id: g.productId!,
      name: resolveI18n(byId.get(g.productId!)?.name as never, language),
      quantity: g._sum.quantity ?? 0,
      revenue: g._sum.total ?? 0,
    }));
  }

  private async topServices(from: Date, to: Date, language: Language) {
    const grouped = await this.prisma.client.booking.groupBy({
      by: ['serviceId'],
      where: { startsAt: { gte: from, lte: to }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
      _count: true,
      _sum: { priceSnapshot: true },
      orderBy: { _sum: { priceSnapshot: 'desc' } },
      take: 10,
    });

    const services = await this.prisma.client.service.findMany({
      where: { id: { in: grouped.map((g) => g.serviceId) } },
      select: { id: true, name: true },
    });
    const byId = new Map(services.map((s) => [s.id, s]));

    return grouped.map((g) => ({
      id: g.serviceId,
      name: resolveI18n(byId.get(g.serviceId)?.name as never, language),
      count: g._count,
      revenue: g._sum.priceSnapshot ?? 0,
    }));
  }

  /**
   * Raw SQL bypasses the Prisma tenant guard entirely — the extension rewrites the query
   * builder's arguments, and there are none here. Every raw query must therefore carry
   * its own tenant predicate, taken from the request context rather than from any
   * argument a caller could influence (risk R13 in
   * docs/architecture/13-technical-risks.md).
   */
  private requireTenantId(): string {
    const tenantId = tenantContext.tenantId();
    if (!tenantId) {
      throw new DomainError(ErrorCode.MISSING_TENANT_CONTEXT, 'Analytics requires a tenant in context');
    }
    return tenantId;
  }

  private async revenueTimeline(from: Date, to: Date, branchId?: string) {
    const tenantId = this.requireTenantId();
    // Grouped in SQL by calendar day: pulling every order into Node to bucket them would
    // not survive a busy month.
    const rows = await this.prisma.client.$queryRaw<{ date: string; revenue: bigint; orders: bigint }[]>`
      SELECT to_char("createdAt", 'YYYY-MM-DD') AS date,
             SUM(total)::bigint AS revenue,
             COUNT(*)::bigint AS orders
      FROM "Order"
      WHERE "tenantId" = ${tenantId}
        AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        AND status <> 'CANCELLED'
        ${branchId ? Prisma.sql`AND "branchId" = ${branchId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ date: r.date, revenue: Number(r.revenue), orders: Number(r.orders) }));
  }

  private async peakBookingHour(): Promise<{ hour: number; count: number } | null> {
    const tenantId = this.requireTenantId();
    const timezone = (await this.prisma.client.tenant.findFirstOrThrow({ select: { timezone: true } })).timezone;

    const rows = await this.prisma.client.$queryRaw<{ hour: number; count: bigint }[]>`
      SELECT EXTRACT(
               HOUR FROM ("startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}
             )::int AS hour,
             COUNT(*)::bigint AS count
      FROM "Booking"
      WHERE "tenantId" = ${tenantId}
        AND status NOT IN ('CANCELLED', 'NO_SHOW')
        AND "startsAt" > now() - interval '60 days'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 1
    `;
    const top = rows[0];
    return top && Number(top.count) >= 3 ? { hour: top.hour, count: Number(top.count) } : null;
  }
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function resolveRange(range: { preset?: string; dateFrom?: string; dateTo?: string }) {
  const now = new Date();
  let from: Date;
  let to = now;

  switch (range.preset) {
    case 'today':
      from = startOfDay(now); break;
    case 'yesterday':
      from = startOfDay(new Date(now.getTime() - 86_400_000));
      to = new Date(startOfDay(now).getTime() - 1); break;
    case 'last7':
      from = new Date(now.getTime() - 7 * 86_400_000); break;
    case 'thisMonth':
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); break;
    case 'custom':
      from = new Date(`${range.dateFrom}T00:00:00Z`);
      to = new Date(`${range.dateTo}T23:59:59Z`); break;
    default:
      from = new Date(now.getTime() - 30 * 86_400_000);
  }

  // The comparison window is the same length immediately before, so "up 20%" always
  // means against a like-for-like period.
  const span = to.getTime() - from.getTime();
  return { from, to, previousFrom: new Date(from.getTime() - span), previousTo: from };
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
