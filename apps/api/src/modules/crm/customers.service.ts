import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bizbot/database';
import { DomainError, ErrorCode, normalizePageParams, paginate, toSkipTake } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';
import { compileSegmentFilter, type SegmentFilter } from './segment-compiler';

/**
 * CRM.
 *
 * Every Telegram customer becomes a record here automatically, so the "database" a small
 * business always wanted but never built is a side effect of using the bot.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>) {
    const page = normalizePageParams(query as { page?: number; pageSize?: number });
    const where: Prisma.CustomerWhereInput = {};

    if (query.search) {
      const search = String(query.search);
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search.replace(/\D/g, '') } },
        { telegramUsername: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (query.tagId) where.tagLinks = { some: { tagId: query.tagId as string } };
    if (query.language) where.language = query.language as string;
    if (query.hasOrders === true) where.orderCount = { gt: 0 };
    if (query.hasOrders === false) where.orderCount = 0;
    if (query.createdFrom || query.createdTo) {
      where.createdAt = {
        ...(query.createdFrom ? { gte: new Date(`${query.createdFrom as string}T00:00:00Z`) } : {}),
        ...(query.createdTo ? { lte: new Date(`${query.createdTo as string}T23:59:59Z`) } : {}),
      };
    }

    // Segments are stored filters, so this applies a tenant-authored definition rather
    // than a hard-coded branch per segment.
    if (query.segmentKey) {
      const segment = await this.prisma.client.customerSegment.findFirst({
        where: { key: query.segmentKey as string },
      });
      if (!segment) throw new DomainError(ErrorCode.NOT_FOUND, 'Segment not found');
      Object.assign(where, compileSegmentFilter(segment.filter as SegmentFilter));
    }

    const sortBy = [
      'createdAt',
      'lastActivityAt',
      'totalSpent',
      'orderCount',
      'firstName',
    ].includes(String(query.sortBy))
      ? String(query.sortBy)
      : 'lastActivityAt';

    const [items, total] = await Promise.all([
      this.prisma.client.customer.findMany({
        where,
        orderBy: { [sortBy]: query.sortOrder ?? 'desc' } as never,
        ...toSkipTake(page),
        include: { tagLinks: { include: { tag: true } } },
      }),
      this.prisma.client.customer.count({ where }),
    ]);

    return paginate(
      items.map((c) => ({ ...c, tags: c.tagLinks.map((l) => l.tag), tagLinks: undefined })),
      total,
      page,
    );
  }

  async detail(id: string) {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id },
      include: {
        tagLinks: { include: { tag: true } },
        addresses: true,
        loyaltyAccount: true,
        notes: { orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }], take: 20 },
        _count: { select: { orders: true, bookings: true, payments: true } },
      },
    });
    if (!customer) throw new DomainError(ErrorCode.NOT_FOUND, 'Customer not found');

    const [orders, bookings, loyaltyTx] = await Promise.all([
      this.prisma.client.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
          paymentStatus: true,
        },
      }),
      this.prisma.client.booking.findMany({
        where: { customerId: id },
        orderBy: { startsAt: 'desc' },
        take: 10,
        include: { service: { select: { name: true } }, resource: { select: { name: true } } },
      }),
      customer.loyaltyAccount
        ? this.prisma.client.loyaltyTransaction.findMany({
            where: { accountId: customer.loyaltyAccount.id },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
    ]);

    return {
      ...customer,
      tags: customer.tagLinks.map((l) => l.tag),
      tagLinks: undefined,
      recentOrders: orders,
      recentBookings: bookings,
      loyaltyTransactions: loyaltyTx,
    };
  }

  /** The unified activity feed, assembled by event handlers rather than written by UI code. */
  async timeline(customerId: string, query: { page?: number; pageSize?: number }) {
    const page = normalizePageParams(query);
    const [items, total] = await Promise.all([
      this.prisma.client.customerTimelineEntry.findMany({
        where: { customerId },
        orderBy: { occurredAt: 'desc' },
        ...toSkipTake(page),
      }),
      this.prisma.client.customerTimelineEntry.count({ where: { customerId } }),
    ]);
    return paginate(items, total, page);
  }

  async create(actorUserId: string, input: Record<string, unknown>) {
    const { tagIds, ...data } = input as { tagIds?: string[] } & Record<string, unknown>;

    if (data.phone) {
      const existing = await this.prisma.client.customer.findFirst({
        where: { phone: data.phone as string },
      });
      // A walk-in captured by phone and the same person on Telegram must converge on one
      // record, or the business ends up with two histories for one customer.
      if (existing) {
        throw new DomainError(ErrorCode.CONFLICT, 'A customer with this phone already exists', {
          customerId: existing.id,
        });
      }
    }

    const customer = await this.prisma.client.customer.create({
      data: {
        ...(data as Record<string, unknown>),
        birthDate: data.birthDate ? new Date(`${data.birthDate as string}T00:00:00Z`) : null,
        loyaltyAccount: { create: {} as never },
        ...(tagIds?.length ? { tagLinks: { create: tagIds.map((tagId) => ({ tagId })) } } : {}),
      } as never,
    });

    await this.audit.record({
      actorUserId,
      action: 'customer.created',
      entityType: 'CUSTOMER',
      entityId: customer.id,
    });
    return this.detail(customer.id);
  }

  async update(actorUserId: string, id: string, input: Record<string, unknown>) {
    const { tagIds, ...data } = input as { tagIds?: string[] } & Record<string, unknown>;
    const before = await this.prisma.client.customer.findFirstOrThrow({ where: { id } });

    const after = await this.prisma.client.customer.update({
      where: { id },
      data: {
        ...(data as Record<string, unknown>),
        ...(data.birthDate ? { birthDate: new Date(`${data.birthDate as string}T00:00:00Z`) } : {}),
      },
    });

    if (tagIds) {
      await this.prisma.client.customerTagLink.deleteMany({ where: { customerId: id } });
      if (tagIds.length > 0) {
        await this.prisma.client.customerTagLink.createMany({
          data: tagIds.map((tagId) => ({ customerId: id, tagId })) as never,
        });
      }
    }

    await this.audit.recordChange(
      { actorUserId, action: 'customer.updated', entityType: 'CUSTOMER', entityId: id },
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    return this.detail(id);
  }

  async addNote(actorUserId: string, customerId: string, body: string, isPinned = false) {
    await this.prisma.client.customer.findFirstOrThrow({ where: { id: customerId } });
    const note = await this.prisma.client.customerNote.create({
      data: { customerId, authorId: actorUserId, body, isPinned } as never,
    });
    await this.prisma.client.customerTimelineEntry.create({
      data: {
        customerId,
        type: 'NOTE_ADDED',
        title: { uz: 'Izoh qo‘shildi', ru: 'Добавлена заметка' } as never,
        body: { uz: body.slice(0, 200) } as never,
      } as never,
    });
    return note;
  }

  async listTags() {
    return this.prisma.client.customerTag.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { links: true } } },
    });
  }

  async createTag(name: string, color: string) {
    return this.prisma.client.customerTag.create({ data: { name, color } as never });
  }

  async listSegments() {
    const segments = await this.prisma.client.customerSegment.findMany({ orderBy: { key: 'asc' } });
    // Counting each segment is N queries, but N is small (a handful of segments) and the
    // number is what makes the list useful rather than decorative.
    return Promise.all(
      segments.map(async (segment) => ({
        ...segment,
        count: await this.prisma.client.customer.count({
          where: compileSegmentFilter(segment.filter as SegmentFilter),
        }),
      })),
    );
  }

  /** Upserts the customer behind a Telegram identity. Called on every bot interaction. */
  async upsertFromTelegram(input: {
    telegramUserId: bigint;
    firstName: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
  }) {
    const existing = await this.prisma.client.customer.findFirst({
      where: { telegramUserId: input.telegramUserId },
    });

    if (existing) {
      return this.prisma.client.customer.update({
        where: { id: existing.id },
        data: {
          lastActivityAt: new Date(),
          telegramUsername: input.username ?? existing.telegramUsername,
          // Never overwrite a language the customer chose explicitly in the app.
          ...(existing.language ? {} : { language: input.languageCode ?? 'uz' }),
        },
      });
    }

    return this.prisma.client.customer.create({
      data: {
        telegramUserId: input.telegramUserId,
        telegramUsername: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        language: input.languageCode ?? 'uz',
        source: 'TELEGRAM',
        loyaltyAccount: { create: {} as never },
      } as never,
    });
  }
}
