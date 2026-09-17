import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { effectivePermissions, type Permission } from '@bizbot/rbac';
import { PUBLIC_KEY, CUSTOMER_KEY, PLATFORM_KEY, SELF_KEY } from '../decorators';
import { PrismaService } from '../../infra/prisma.service';
import { TenantCache } from '../../infra/tenant-cache.service';

/**
 * Resolves and authorizes the tenant, then puts it in the request.
 *
 * Layer ② of tenant isolation. Nothing downstream may re-derive the tenant from request
 * input; the context this guard establishes is the only source of truth for the rest of
 * the request (docs/architecture/02-tenant-isolation.md).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cache: TenantCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler)) return true;
    // Platform routes are cross-tenant by nature and use PlatformGuard instead.
    if (this.reflector.getAllAndOverride<string[]>(PLATFORM_KEY, handler)) return true;
    // Self routes act on the actor's own account, so there is no tenant to resolve.
    if (this.reflector.getAllAndOverride<boolean>(SELF_KEY, handler)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const isCustomerRoute = this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, handler) === true;

    const tenantId = isCustomerRoute
      ? await this.tenantFromCustomerSession(request)
      : this.tenantFromRequest(request);

    if (!tenantId) {
      throw new DomainError(ErrorCode.MISSING_TENANT_CONTEXT, 'No tenant specified for this request');
    }

    const tenant = await this.cache.getTenant(tenantId);
    if (!tenant) throw new DomainError(ErrorCode.NOT_FOUND, 'Business not found');
    if (tenant.status === 'SUSPENDED' || tenant.status === 'DELETED') {
      throw new DomainError(ErrorCode.TENANT_SUSPENDED);
    }

    let role: RequestTenantRole | undefined;
    let permissions: ReadonlySet<Permission> = new Set();

    if (!isCustomerRoute) {
      const userId = request.actor?.userId;
      if (!userId) throw new DomainError(ErrorCode.UNAUTHENTICATED);

      const membership = await this.prisma.system('resolve-membership', () =>
        this.prisma.raw.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId, userId } },
          select: { role: true, permissionOverrides: true, isActive: true },
        }),
      );

      // A platform admin may read any tenant, but that access is audited and does not
      // silently grant the permissions of an owner.
      if (!membership || !membership.isActive) {
        if (request.actor?.platformRole === 'ADMIN' || request.actor?.platformRole === 'SUPPORT') {
          role = 'OWNER';
          permissions = effectivePermissions('OWNER');
          request.actor.type = 'USER';
        } else {
          throw new DomainError(ErrorCode.NOT_A_MEMBER);
        }
      } else {
        role = membership.role;
        permissions = effectivePermissions(
          membership.role,
          membership.permissionOverrides as { grant?: Permission[]; revoke?: Permission[] } | null,
        );
      }
    }

    request.tenant = {
      id: tenant.id,
      slug: tenant.slug,
      role,
      permissions,
      enabledModules: tenant.enabledModules,
      timezone: tenant.timezone,
      currency: tenant.currency,
      defaultLanguage: tenant.defaultLanguage,
    };
    return true;
  }

  /** Path parameter first (self-describing logs), then the explicit header. */
  private tenantFromRequest(request: Request): string | undefined {
    const fromPath = (request.params as Record<string, string | undefined>)?.tenantId;
    if (fromPath) return fromPath;
    const fromHeader = request.header('x-tenant-id');
    return fromHeader && fromHeader.length > 0 ? fromHeader : undefined;
  }

  /**
   * A customer's tenant comes from their signed token, never from the request — a
   * customer must not be able to point their session at another business.
   */
  private async tenantFromCustomerSession(request: Request): Promise<string | undefined> {
    const customerId = request.actor?.customerId;
    if (!customerId) return undefined;
    const customer = await this.prisma.system('resolve-customer-tenant', () =>
      this.prisma.raw.customer.findUnique({
        where: { id: customerId },
        select: { tenantId: true, isBlocked: true },
      }),
    );
    if (!customer) return undefined;
    if (customer.isBlocked) throw new DomainError(ErrorCode.FORBIDDEN, 'Customer is blocked');
    return customer.tenantId;
  }
}

type RequestTenantRole = NonNullable<Request['tenant']>['role'];
