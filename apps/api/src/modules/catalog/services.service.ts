import { Injectable } from '@nestjs/common';
import { DomainError, ErrorCode, type Language } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Services (the bookable kind).
 *
 * Creating a service optionally assigns employees to it; that assignment is what the
 * availability engine uses to decide which specialists can be booked for it.
 */
@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>, _language: Language = 'uz') {
    return this.prisma.client.service.findMany({
      where: {
        archivedAt: null,
        ...(query.isActive !== undefined ? { isActive: query.isActive === 'true' || query.isActive === true } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId as string } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        employeeServices: {
          include: { employee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
        },
      },
    });
  }

  async detail(id: string) {
    const service = await this.prisma.client.service.findFirst({
      where: { id },
      include: {
        category: true,
        employeeServices: { include: { employee: true } },
      },
    });
    if (!service) throw new DomainError(ErrorCode.NOT_FOUND, 'Service not found');
    return service;
  }

  async create(actorUserId: string, input: Record<string, unknown>) {
    const { employeeIds, ...data } = input as { employeeIds?: string[] } & Record<string, unknown>;

    if (employeeIds?.length) await this.assertEmployeesExist(employeeIds);

    const service = await this.prisma.client.service.create({
      data: {
        ...(data as Record<string, unknown>),
        ...(employeeIds?.length
          ? { employeeServices: { create: employeeIds.map((employeeId) => ({ employeeId })) } }
          : {}),
      } as never,
    });

    await this.audit.record({
      actorUserId, action: 'service.created', entityType: 'SERVICE', entityId: service.id,
    });
    return this.detail(service.id);
  }

  async update(actorUserId: string, id: string, input: Record<string, unknown>) {
    const { employeeIds, ...data } = input as { employeeIds?: string[] } & Record<string, unknown>;
    const before = await this.prisma.client.service.findFirstOrThrow({ where: { id } });

    const after = await this.prisma.client.service.update({ where: { id }, data: data as never });

    if (employeeIds) {
      await this.assertEmployeesExist(employeeIds);
      await this.prisma.client.employeeService.deleteMany({ where: { serviceId: id } });
      if (employeeIds.length > 0) {
        await this.prisma.client.employeeService.createMany({
          data: employeeIds.map((employeeId) => ({ employeeId, serviceId: id })) as never,
        });
      }
    }

    await this.audit.recordChange(
      { actorUserId, action: 'service.updated', entityType: 'SERVICE', entityId: id },
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    return this.detail(id);
  }

  async archive(actorUserId: string, id: string) {
    // Future bookings would be orphaned by a hard delete, and past ones keep a name
    // snapshot but still reference the service for reporting.
    const upcoming = await this.prisma.client.booking.count({
      where: { serviceId: id, startsAt: { gt: new Date() }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
    });
    if (upcoming > 0) {
      throw new DomainError(ErrorCode.CONFLICT, 'This service has upcoming bookings', { upcoming });
    }

    await this.prisma.client.service.update({
      where: { id }, data: { archivedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      actorUserId, action: 'service.archived', entityType: 'SERVICE', entityId: id,
    });
  }

  private async assertEmployeesExist(ids: string[]) {
    const found = await this.prisma.client.employee.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'One or more employees do not exist');
    }
  }
}
