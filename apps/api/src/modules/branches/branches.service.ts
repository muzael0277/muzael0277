import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bizbot/database';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Branches and employees.
 *
 * Creating an employee also creates their bookable resource, so a salon owner never has
 * to learn what a "resource" is. The indirection exists for clinics and car services
 * that book rooms and lifts (ADR-0007); it stays invisible for the common case.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listBranches() {
    return this.prisma.client.branch.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
      include: { _count: { select: { employees: true, orders: true, bookings: true } } },
    });
  }

  async createBranch(actorUserId: string, data: Record<string, unknown>) {
    if (data.isDefault) {
      // Exactly one default, or order routing becomes ambiguous.
      await this.prisma.client.branch.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const branch = await this.prisma.client.branch.create({ data: data as never });
    await this.audit.record({
      actorUserId, action: 'branch.created', entityType: 'BRANCH', entityId: branch.id,
    });
    return branch;
  }

  async updateBranch(id: string, data: Record<string, unknown>) {
    if (data.isDefault) {
      await this.prisma.client.branch.updateMany({
        where: { isDefault: true, id: { not: id } }, data: { isDefault: false },
      });
    }
    return this.prisma.client.branch.update({ where: { id }, data: data as never });
  }

  async deleteBranch(id: string) {
    const upcoming = await this.prisma.client.booking.count({
      where: { branchId: id, startsAt: { gt: new Date() }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
    });
    if (upcoming > 0) {
      throw new DomainError(ErrorCode.CONFLICT, 'This branch has upcoming bookings', { upcoming });
    }
    // Deactivate rather than delete: orders reference the branch for reporting.
    await this.prisma.client.branch.update({ where: { id }, data: { isActive: false } });
  }

  async listEmployees() {
    return this.prisma.client.employee.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        branch: { select: { id: true, name: true } },
        services: { include: { service: { select: { id: true, name: true } } } },
        resource: { include: { schedules: true } },
      },
    });
  }

  async employeeDetail(id: string) {
    const employee = await this.prisma.client.employee.findFirst({
      where: { id },
      include: {
        branch: true,
        services: { include: { service: true } },
        resource: { include: { schedules: true, timeOff: { where: { endsAt: { gte: new Date() } } } } },
      },
    });
    if (!employee) throw new DomainError(ErrorCode.NOT_FOUND, 'Employee not found');
    return employee;
  }

  async createEmployee(
    actorUserId: string,
    input: {
      firstName: string; lastName?: string; position?: string; phone?: string;
      branchId?: string; avatarUrl?: string | null;
      serviceIds?: string[];
      schedule?: { weekday: number; start: string; end: string }[];
    },
  ) {
    const { serviceIds, schedule, ...data } = input;

    const employee = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          ...(data as Record<string, unknown>),
          ...(serviceIds?.length
            ? { services: { create: serviceIds.map((serviceId) => ({ serviceId })) } }
            : {}),
        } as never,
      });

      // The employee's bookable resource, created automatically. A default Monday–Saturday
      // schedule means a new hire is bookable straight away instead of silently invisible.
      const windows = schedule?.length
        ? schedule
        : [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '10:00', end: '19:00' }));

      await tx.bookingResource.create({
        data: {
          tenantId: created.tenantId,
          employeeId: created.id,
          branchId: created.branchId,
          name: [created.firstName, created.lastName].filter(Boolean).join(' '),
          kind: 'EMPLOYEE',
          schedules: {
            create: windows.map((w) => ({
              tenantId: created.tenantId, weekday: w.weekday, startTime: w.start, endTime: w.end,
            })),
          },
        } as Prisma.BookingResourceUncheckedCreateInput,
      });

      return created;
    });

    await this.audit.record({
      actorUserId, action: 'employee.created', entityType: 'EMPLOYEE', entityId: employee.id,
    });
    return this.employeeDetail(employee.id);
  }

  async updateEmployee(
    id: string,
    input: { serviceIds?: string[]; schedule?: { weekday: number; start: string; end: string }[] } & Record<string, unknown>,
  ) {
    const { serviceIds, schedule, ...data } = input;
    const employee = await this.prisma.client.employee.update({ where: { id }, data: data as never });

    if (serviceIds) {
      await this.prisma.client.employeeService.deleteMany({ where: { employeeId: id } });
      if (serviceIds.length > 0) {
        await this.prisma.client.employeeService.createMany({
          data: serviceIds.map((serviceId) => ({ employeeId: id, serviceId })) as never,
        });
      }
    }

    if (schedule) {
      const resource = await this.prisma.client.bookingResource.findFirst({ where: { employeeId: id } });
      if (resource) {
        await this.prisma.client.resourceSchedule.deleteMany({ where: { resourceId: resource.id } });
        await this.prisma.client.resourceSchedule.createMany({
          data: schedule.map((w) => ({
            resourceId: resource.id, weekday: w.weekday, startTime: w.start, endTime: w.end,
          })) as never,
        });
      }
    }

    // Keep the resource's display name in step with the employee's.
    if (data.firstName || data.lastName) {
      await this.prisma.client.bookingResource.updateMany({
        where: { employeeId: id },
        data: { name: [employee.firstName, employee.lastName].filter(Boolean).join(' ') },
      });
    }

    return this.employeeDetail(id);
  }

  async deactivateEmployee(id: string) {
    const upcoming = await this.prisma.client.booking.count({
      where: {
        resource: { employeeId: id },
        startsAt: { gt: new Date() },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
    });
    if (upcoming > 0) {
      throw new DomainError(ErrorCode.CONFLICT, 'This employee has upcoming bookings. Reassign them first.', {
        upcoming,
      });
    }
    await this.prisma.client.employee.update({ where: { id }, data: { isActive: false } });
    await this.prisma.client.bookingResource.updateMany({
      where: { employeeId: id }, data: { isActive: false },
    });
  }
}
