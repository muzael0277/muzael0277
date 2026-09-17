import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@bizbot/shared';
import type { Permission } from '@bizbot/rbac';
import { CUSTOMER_KEY, PERMISSION_KEY, PLATFORM_KEY, PUBLIC_KEY, SELF_KEY } from '../decorators';

/**
 * Authorization. Layer ② for *what* the actor may do, after TenantGuard established
 * *whose* data they are touching.
 *
 * A route with no @RequirePermission is a startup error, not an open door — see
 * RouteAuditService. That check is what makes "someone forgot the decorator" a failed
 * deploy rather than a silent hole.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler)) return true;
    if (this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, handler)) return true;
    if (this.reflector.getAllAndOverride<string[]>(PLATFORM_KEY, handler)) return true;
    // Authenticated-but-tenantless: JwtAuthGuard has already established who this is,
    // and the handler authorizes against the actor's own id.
    if (this.reflector.getAllAndOverride<boolean>(SELF_KEY, handler)) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSION_KEY, handler);
    if (!required || required.length === 0) {
      // Should be unreachable: the boot-time audit refuses to start with such a route.
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'Route has no declared permission and is refused by default',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const granted = request.tenant?.permissions;
    if (!granted) throw new DomainError(ErrorCode.NOT_A_MEMBER);

    // Multiple permissions on one route mean "any of these", which is how read routes
    // shared by several roles are expressed.
    if (!required.some((permission) => granted.has(permission))) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Insufficient permissions', {
        required,
        role: request.tenant?.role,
      });
    }
    return true;
  }
}
