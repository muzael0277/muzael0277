import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@bizbot/shared';
import type { ModuleKey } from '@bizbot/rbac';
import { MODULE_KEY, PUBLIC_KEY } from '../decorators';

/**
 * A module a tenant has not enabled is genuinely off, not merely hidden in the UI.
 * Without this, "disabled" would only mean "the button is not rendered".
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler)) return true;

    const required = this.reflector.getAllAndOverride<ModuleKey[]>(MODULE_KEY, handler);
    if (!required || required.length === 0) return true;

    const enabled = context.switchToHttp().getRequest<Request>().tenant?.enabledModules;
    if (!enabled) throw new DomainError(ErrorCode.MISSING_TENANT_CONTEXT);

    const missing = required.filter((module) => !enabled.has(module));
    if (missing.length > 0) {
      throw new DomainError(ErrorCode.MODULE_DISABLED, 'Module is not enabled for this business', {
        modules: missing,
      });
    }
    return true;
  }
}
