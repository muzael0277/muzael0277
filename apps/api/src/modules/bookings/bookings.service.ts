import { Injectable } from '@nestjs/common';
import { Prisma, type BookingStatus } from '@bizbot/database';
import {
  DomainError, ErrorCode, localDateString, localWeekday, normalizePageParams,
  paginate, toSkipTake, type Weekday,
} from '@bizbot/shared';
import type { CreateBookingInput } from '@bizbot/contracts';
import { randomCode } from '@bizbot/shared/server';
import { PrismaService } from '../../infra/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/event-types';
import { AuditService } from '../audit/audit.service';
import { computeAvailability, hoursForWeekday, type AvailableSlot } from './availability.engine';

/**
 * Bookings.
 *
 * The availability endpoint is advisory — it can go stale in the seconds between a
 * customer seeing a slot and tapping confirm. Invariant I3 is upheld in `create`, which
 * re-checks under a per-resource-per-day lock inside the write transaction. The database
 * also carries a GiST exclusion constraint as a second line of defence, so even a future
 * code path that forgets the lock cannot produce two overlapping appointments.
 */

const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  ARRIVED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

interface BookingSettings {
  slotStepMinutes: number;
  minLeadTimeMinutes: number;
  maxAdvanceDays: number;
  autoConfirm: boolean;
  cancellationDeadlineMinutes: number;
  reminderOffsetsMinutes: number[];
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  // ── availability ─────────────────────────────────────────────────────────────

  async getAvailability(query: {
    serviceId: string; date: string; branchId?: string; resourceId?: string; employeeId?: string;
  }) {
    const [service, tenant] = await Promise.all([
      this.prisma.client.service.findFirstOrThrow({ where: { id: query.serviceId, isActive: true } }),
      this.loadTenantContext(),
    ]);

    const resources = await this.resourcesForService(query);
    if (resources.length === 0) {
      return { date: query.date, service: { id: service.id, durationMinutes: service.durationMinutes }, resources: [] };
    }

    const weekday = localWeekday(new Date(`${query.date}T12:00:00Z`), tenant.timezone) as Weekday;
    const dayStart = new Date(`${query.date}T00:00:00Z`);
    const dayEnd = new Date(`${query.date}T23:59:59Z`);
    // A window wide enough to catch appointments that start the previous evening and
    // spill over, or start late and run past midnight.
    const windowStart = new Date(dayStart.getTime() - 24 * 3600_000);
    const windowEnd = new Date(dayEnd.getTime() + 24 * 3600_000);

    const [bookings, timeOff] = await Promise.all([
      this.prisma.client.booking.findMany({
        where: {
          resourceId: { in: resources.map((r) => r.id) },
          status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          blockStartsAt: { lt: windowEnd },
          blockEndsAt: { gt: windowStart },
        },
        select: { resourceId: true, blockStartsAt: true, blockEndsAt: true },
      }),
      this.prisma.client.resourceTimeOff.findMany({
        where: {
          resourceId: { in: resources.map((r) => r.id) },
          startsAt: { lt: windowEnd }, endsAt: { gt: windowStart },
        },
        select: { resourceId: true, startsAt: true, endsAt: true },
      }),
    ]);

    const now = new Date();
    const settings = this.bookingSettings(tenant.settings?.bookingSettings);

    const perResource = resources.map((resource) => {
      const blocked = [
        ...bookings.filter((b) => b.resourceId === resource.id)
          .map((b) => ({ startsAt: b.blockStartsAt, endsAt: b.blockEndsAt })),
        ...timeOff.filter((t) => t.resourceId === resource.id)
          .map((t) => ({ startsAt: t.startsAt, endsAt: t.endsAt })),
      ];

      const slots = computeAvailability({
        date: query.date,
        timezone: tenant.timezone,
        now,
        serviceDurationMinutes: service.durationMinutes,
        serviceBufferBeforeMinutes: service.bufferBeforeMinutes,
        serviceBufferAfterMinutes: service.bufferAfterMinutes,
        resourceBufferBeforeMinutes: resource.bufferBeforeMinutes,
        resourceBufferAfterMinutes: resource.bufferAfterMinutes,
        businessHours: hoursForWeekday(tenant.settings?.workingHours, weekday),
        branchHours: hoursForWeekday(resource.branch?.workingHours, weekday),
        resourceSchedule: resource.schedules.map((s) => ({
          weekday: s.weekday as Weekday, startTime: s.startTime, endTime: s.endTime,
        })),
        blocked,
        slotStepMinutes: settings.slotStepMinutes,
        minLeadTimeMinutes: settings.minLeadTimeMinutes,
        maxAdvanceDays: settings.maxAdvanceDays,
      });

      return {
        resource: {
          id: resource.id,
          name: resource.name,
          kind: resource.kind,
          employeeId: resource.employeeId,
          avatarUrl: resource.employee?.avatarUrl ?? null,
          branchId: resource.branchId,
        },
        slots: slots.map((s) => ({ startsAt: s.startsAt, label: s.label })),
      };
    });

    return {
      date: query.date,
      service: {
        id: service.id, name: service.name, price: service.price,
        durationMinutes: service.durationMinutes,
      },
      resources: perResource,
      // A merged view, so a customer who does not care which specialist sees one list.
      anySlots: this.mergeSlots(perResource),
    };
  }

  // ── creation ─────────────────────────────────────────────────────────────────

  async create(input: CreateBookingInput, actor: { userId?: string; customerId?: string }) {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Invalid start time');
    }

    const [service, tenant] = await Promise.all([
      this.prisma.client.service.findFirstOrThrow({ where: { id: input.serviceId, isActive: true } }),
      this.loadTenantContext(),
    ]);
    const settings = this.bookingSettings(tenant.settings?.bookingSettings);

    const resource = await this.resolveResource(input, service.id);
    const customer = await this.resolveCustomer(input, actor);

    const bufferBefore = Math.max(service.bufferBeforeMinutes, resource.bufferBeforeMinutes);
    const bufferAfter = Math.max(service.bufferAfterMinutes, resource.bufferAfterMinutes);
    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
    const blockStartsAt = new Date(startsAt.getTime() - bufferBefore * 60_000);
    const blockEndsAt = new Date(endsAt.getTime() + bufferAfter * 60_000);

    const now = new Date();
    if (startsAt.getTime() < now.getTime() + settings.minLeadTimeMinutes * 60_000) {
      throw new DomainError(ErrorCode.BOOKING_TOO_SOON, undefined, {
        minLeadTimeMinutes: settings.minLeadTimeMinutes,
      });
    }
    if (startsAt.getTime() > now.getTime() + settings.maxAdvanceDays * 86_400_000) {
      throw new DomainError(ErrorCode.BOOKING_TOO_FAR, undefined, { maxAdvanceDays: settings.maxAdvanceDays });
    }

    // The slot must still be inside working hours — a client could post any instant.
    await this.assertWithinWorkingHours(startsAt, endsAt, resource, tenant, service, settings);

    const day = new Date(`${localDateString(startsAt, tenant.timezone)}T00:00:00Z`);
    const status: BookingStatus = settings.autoConfirm ? 'CONFIRMED' : 'PENDING';

    const booking = await this.prisma.client.$transaction(
      async (tx) => {
        // Serialize every writer for this resource on this day. Narrow on purpose: two
        // barbers, or the same barber on two days, never contend with each other.
        await tx.$executeRaw`
          INSERT INTO "ResourceDayLock" ("tenantId", "resourceId", "day")
          VALUES (${tenant.id}, ${resource.id}, ${day}::date)
          ON CONFLICT DO NOTHING
        `;
        await tx.$queryRaw`
          SELECT 1 FROM "ResourceDayLock"
          WHERE "tenantId" = ${tenant.id}
            AND "resourceId" = ${resource.id}
            AND "day" = ${day}::date
          FOR UPDATE
        `;

        // Re-check under the lock. This is the check that matters; the one the customer
        // saw was a snapshot from seconds ago.
        const conflict = await tx.booking.findFirst({
          where: {
            resourceId: resource.id,
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
            blockStartsAt: { lt: blockEndsAt },
            blockEndsAt: { gt: blockStartsAt },
          },
          select: { id: true, startsAt: true },
        });
        if (conflict) {
          throw new DomainError(ErrorCode.BOOKING_SLOT_TAKEN, undefined, {
            resourceId: resource.id, startsAt: startsAt.toISOString(),
          });
        }

        const created = await tx.booking.create({
          data: {
            tenantId: tenant.id,
            bookingNumber: `B-${randomCode(6)}`,
            customerId: customer.id,
            serviceId: service.id,
            resourceId: resource.id,
            branchId: resource.branchId ?? input.branchId ?? null,
            status,
            startsAt, endsAt, blockStartsAt, blockEndsAt,
            durationMinutes: service.durationMinutes,
            priceSnapshot: service.price,
            serviceNameSnapshot: service.name as Prisma.InputJsonValue,
            currency: tenant.currency,
            customerComment: input.comment,
            customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
            source: actor.customerId ? 'MINIAPP' : 'ADMIN',
            confirmedAt: status === 'CONFIRMED' ? new Date() : null,
            statusHistory: {
              create: { tenantId: tenant.id, toStatus: status, changedById: actor.userId ?? null },
            },
          },
        });

        await tx.customer.update({
          where: { id: customer.id },
          data: { bookingCount: { increment: 1 }, lastActivityAt: new Date() },
        });

        // Written in the same transaction as the booking: no event ever announces an
        // appointment that got rolled back.
        await this.events.emit(tx, DomainEventType.BOOKING_CREATED, { type: 'BOOKING', id: created.id }, {
          bookingId: created.id,
          bookingNumber: created.bookingNumber,
          customerId: customer.id,
          serviceId: service.id,
          resourceId: resource.id,
          startsAt: startsAt.toISOString(),
        });

        return created;
      },
      // A short timeout: holding the day lock while something else is slow would stall
      // every other booking for this resource.
      { timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    return this.detail(booking.id);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async updateStatus(id: string, next: BookingStatus, actor: { userId?: string }, comment?: string) {
    const booking = await this.prisma.client.booking.findFirstOrThrow({ where: { id } });

    const allowed = ALLOWED_TRANSITIONS[booking.status];
    if (!allowed.includes(next)) {
      throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, undefined, {
        from: booking.status, to: next, allowed,
      });
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const result = await tx.booking.update({
        where: { id },
        data: {
          status: next,
          version: { increment: 1 },
          confirmedAt: next === 'CONFIRMED' ? new Date() : undefined,
          completedAt: next === 'COMPLETED' ? new Date() : undefined,
          cancelledAt: next === 'CANCELLED' || next === 'NO_SHOW' ? new Date() : undefined,
          cancelReason: next === 'CANCELLED' ? comment : undefined,
          statusHistory: {
            create: {
              tenantId: booking.tenantId, fromStatus: booking.status, toStatus: next,
              changedById: actor.userId ?? null, comment,
            },
          },
        },
      });

      if (next === 'COMPLETED') {
        await this.events.emit(tx, DomainEventType.BOOKING_COMPLETED, { type: 'BOOKING', id }, {
          bookingId: id, customerId: booking.customerId, price: booking.priceSnapshot,
        });
      } else if (next === 'CANCELLED') {
        await this.events.emit(tx, DomainEventType.BOOKING_CANCELLED, { type: 'BOOKING', id }, {
          bookingId: id, customerId: booking.customerId,
          startsAt: booking.startsAt.toISOString(), reason: comment,
        });
      }
      return result;
    });

    await this.audit.record({
      tenantId: booking.tenantId, actorUserId: actor.userId, action: 'booking.status_changed',
      entityType: 'BOOKING', entityId: id,
      before: { status: booking.status }, after: { status: next },
    });
    return updated;
  }

  /** Customer-initiated cancellation, subject to the tenant's deadline. */
  async cancelByCustomer(id: string, customerId: string, reason?: string) {
    const booking = await this.prisma.client.booking.findFirstOrThrow({ where: { id, customerId } });
    const tenant = await this.loadTenantContext();
    const settings = this.bookingSettings(tenant.settings?.bookingSettings);

    if (!ALLOWED_TRANSITIONS[booking.status].includes('CANCELLED')) {
      throw new DomainError(ErrorCode.BOOKING_NOT_CANCELLABLE, undefined, { status: booking.status });
    }

    const deadline = booking.startsAt.getTime() - settings.cancellationDeadlineMinutes * 60_000;
    if (Date.now() > deadline) {
      throw new DomainError(ErrorCode.BOOKING_NOT_CANCELLABLE, undefined, {
        cancellationDeadlineMinutes: settings.cancellationDeadlineMinutes,
      });
    }
    return this.updateStatus(id, 'CANCELLED', {}, reason);
  }

  // ── queries ──────────────────────────────────────────────────────────────────

  async list(query: Record<string, unknown>) {
    const page = normalizePageParams(query as { page?: number; pageSize?: number });
    const where: Prisma.BookingWhereInput = {};

    if (query.status) {
      where.status = Array.isArray(query.status)
        ? { in: query.status as BookingStatus[] }
        : (query.status as BookingStatus);
    }
    if (query.resourceId) where.resourceId = query.resourceId as string;
    if (query.branchId) where.branchId = query.branchId as string;
    if (query.serviceId) where.serviceId = query.serviceId as string;
    if (query.customerId) where.customerId = query.customerId as string;
    if (query.employeeId) where.resource = { employeeId: query.employeeId as string };
    if (query.dateFrom || query.dateTo) {
      where.startsAt = {
        ...(query.dateFrom ? { gte: new Date(`${query.dateFrom as string}T00:00:00Z`) } : {}),
        ...(query.dateTo ? { lte: new Date(`${query.dateTo as string}T23:59:59Z`) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.client.booking.findMany({
        where,
        orderBy: { [String(query.sortBy ?? 'startsAt')]: query.sortOrder ?? 'asc' } as never,
        ...toSkipTake(page),
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true, telegramUsername: true } },
          service: { select: { id: true, name: true, durationMinutes: true } },
          resource: { select: { id: true, name: true, kind: true, employeeId: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.client.booking.count({ where }),
    ]);
    return paginate(items, total, page);
  }

  async detail(id: string) {
    return this.prisma.client.booking.findFirstOrThrow({
      where: { id },
      include: {
        customer: true,
        service: true,
        resource: { include: { employee: true } },
        branch: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: true,
      },
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async loadTenantContext() {
    // The guarded client already scopes this to the request's tenant.
    const tenant = await this.prisma.client.tenant.findFirstOrThrow({ include: { settings: true } });
    return tenant;
  }

  private bookingSettings(raw: unknown): BookingSettings {
    const value = (raw ?? {}) as Partial<BookingSettings>;
    return {
      slotStepMinutes: value.slotStepMinutes ?? 15,
      minLeadTimeMinutes: value.minLeadTimeMinutes ?? 60,
      maxAdvanceDays: value.maxAdvanceDays ?? 30,
      autoConfirm: value.autoConfirm ?? true,
      cancellationDeadlineMinutes: value.cancellationDeadlineMinutes ?? 120,
      reminderOffsetsMinutes: value.reminderOffsetsMinutes ?? [1440, 120],
    };
  }

  private async resourcesForService(query: { serviceId: string; branchId?: string; resourceId?: string; employeeId?: string }) {
    const where: Prisma.BookingResourceWhereInput = { isActive: true };
    if (query.resourceId) where.id = query.resourceId;
    if (query.branchId) where.branchId = query.branchId;
    if (query.employeeId) where.employeeId = query.employeeId;
    // Only staff qualified for this service, when the resource is a person. Non-employee
    // resources (a room, a chair) are not service-restricted in MVP.
    if (!query.resourceId) {
      where.OR = [
        { employee: { services: { some: { serviceId: query.serviceId } } } },
        { employeeId: null },
      ];
    }

    return this.prisma.client.bookingResource.findMany({
      where,
      include: {
        schedules: true,
        branch: { select: { id: true, workingHours: true } },
        employee: { select: { id: true, avatarUrl: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  private async resolveResource(input: CreateBookingInput, serviceId: string) {
    if (input.resourceId) {
      return this.prisma.client.bookingResource.findFirstOrThrow({
        where: { id: input.resourceId, isActive: true },
        include: { schedules: true, branch: { select: { id: true, workingHours: true } } },
      });
    }
    if (input.employeeId) {
      return this.prisma.client.bookingResource.findFirstOrThrow({
        where: { employeeId: input.employeeId, isActive: true },
        include: { schedules: true, branch: { select: { id: true, workingHours: true } } },
      });
    }
    // "Any available specialist": pick the first qualified resource. The transaction
    // still re-checks, so a race just means the customer is told to choose again.
    const candidates = await this.resourcesForService({ serviceId, branchId: input.branchId });
    const first = candidates[0];
    if (!first) throw new DomainError(ErrorCode.RESOURCE_UNAVAILABLE, 'No specialist can perform this service');
    return first;
  }

  private async resolveCustomer(input: CreateBookingInput, actor: { customerId?: string }) {
    if (actor.customerId) {
      return this.prisma.client.customer.findFirstOrThrow({ where: { id: actor.customerId } });
    }
    if (input.customerId) {
      return this.prisma.client.customer.findFirstOrThrow({ where: { id: input.customerId } });
    }
    if (input.customerPhone) {
      const existing = await this.prisma.client.customer.findFirst({ where: { phone: input.customerPhone } });
      if (existing) return existing;
      return this.prisma.client.customer.create({
        data: {
          firstName: input.customerName ?? 'Mijoz',
          phone: input.customerPhone,
          source: 'MANUAL',
          loyaltyAccount: { create: {} as never },
        } as never,
      });
    }
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'A customer or phone number is required');
  }

  private async assertWithinWorkingHours(
    startsAt: Date,
    _endsAt: Date,
    resource: { id: string; schedules: { weekday: number; startTime: string; endTime: string }[];
                branch?: { workingHours: unknown } | null; bufferBeforeMinutes: number; bufferAfterMinutes: number },
    tenant: { timezone: string; settings: { workingHours: unknown } | null },
    service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number },
    settings: BookingSettings,
  ) {
    const date = localDateString(startsAt, tenant.timezone);
    const weekday = localWeekday(startsAt, tenant.timezone) as Weekday;

    // Lead time and horizon are checked separately above, so they are neutralised here:
    // `now` must be the real clock, because an epoch `now` plus a 3650-day horizon lands
    // in 1979 and silently rejects every slot the availability endpoint just offered.
    const slots = computeAvailability({
      date, timezone: tenant.timezone, now: new Date(0),
      serviceDurationMinutes: service.durationMinutes,
      serviceBufferBeforeMinutes: service.bufferBeforeMinutes,
      serviceBufferAfterMinutes: service.bufferAfterMinutes,
      resourceBufferBeforeMinutes: resource.bufferBeforeMinutes,
      resourceBufferAfterMinutes: resource.bufferAfterMinutes,
      businessHours: hoursForWeekday(tenant.settings?.workingHours, weekday),
      branchHours: hoursForWeekday(resource.branch?.workingHours, weekday),
      resourceSchedule: resource.schedules.map((s) => ({
        weekday: s.weekday as Weekday, startTime: s.startTime, endTime: s.endTime,
      })),
      blocked: [],
      slotStepMinutes: settings.slotStepMinutes,
      minLeadTimeMinutes: 0,
      // Large enough that the horizon cannot reject a slot here; the real limit was
      // already enforced against the actual clock.
      maxAdvanceDays: 400_000,
    });

    if (!slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())) {
      throw new DomainError(ErrorCode.BOOKING_OUTSIDE_WORKING_HOURS, undefined, {
        startsAt: startsAt.toISOString(),
      });
    }
  }

  private mergeSlots(perResource: { resource: { id: string; name: string }; slots: { startsAt: Date; label: string }[] }[]) {
    const byTime = new Map<number, { startsAt: Date; label: string; resourceIds: string[] }>();
    for (const entry of perResource) {
      for (const slot of entry.slots) {
        const key = slot.startsAt.getTime();
        const existing = byTime.get(key);
        if (existing) existing.resourceIds.push(entry.resource.id);
        else byTime.set(key, { startsAt: slot.startsAt, label: slot.label, resourceIds: [entry.resource.id] });
      }
    }
    return [...byTime.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }
}

export type { AvailableSlot };
