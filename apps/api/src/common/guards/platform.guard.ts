import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { PLATFORM_KEY } from '../decorators';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Platform (super admin) surface.
 *
 * Every cross-tenant access is written to the audit log before the handler runs, because
 * the point of an audit trail is that it exists even when the request later fails.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<('SUPPORT' | 'ADMIN')[]>(PLATFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const role = request.actor?.platformRole;
    if (!role || role === 'NONE' || !required.includes(role)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Platform access required');
    }

    await this.audit.recordPlatformAccess({
      userId: request.actor!.userId!,
      action: `platform.${request.method.toLowerCase()}`,
      path: request.originalUrl,
      ip: request.ip,
      userAgent: request.header('user-agent'),
      requestId: request.requestId,
    });
    return true;
  }
}
