import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@bizbot/rbac';
import type { ModuleKey } from '@bizbot/rbac';
import type { RequestActor, RequestTenant } from './types';

export const PUBLIC_KEY = 'bizbot:public';
export const PERMISSION_KEY = 'bizbot:permission';
export const MODULE_KEY = 'bizbot:module';
export const PLATFORM_KEY = 'bizbot:platform';
export const CUSTOMER_KEY = 'bizbot:customer';
export const SELF_KEY = 'bizbot:self';
export const IDEMPOTENT_KEY = 'bizbot:idempotent';

/** No session required. Every use is reviewed — this is the only way past authentication. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Declares the permission a route needs.
 *
 * Required on every non-public staff route: the boot-time route audit refuses to start
 * the application if one is missing, which turns "someone forgot the guard" from a
 * vulnerability into a failed deploy (docs/architecture/03-rbac-permissions.md).
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);

/**
 * Requires a staff session but no tenant.
 *
 * The fourth route class, and one the first draft of this system was missing: routes
 * that act on the actor's *own* account or create a business that does not exist yet.
 * They cannot carry a tenant permission (there is no tenant), and marking them @Public
 * would be a lie that removes authentication. The boot-time audit caught all four of
 * them, which is exactly what it is for.
 */
export const AuthenticatedRoute = () => SetMetadata(SELF_KEY, true);

/** The tenant must have this module enabled, or the route returns MODULE_DISABLED. */
export const RequireModule = (...modules: ModuleKey[]) => SetMetadata(MODULE_KEY, modules);

/** Platform staff only (super admin surface). */
export const RequirePlatformRole = (...roles: ('SUPPORT' | 'ADMIN')[]) =>
  SetMetadata(PLATFORM_KEY, roles);

/** Authenticated by a customer session (Mini App / bot), not a staff session. */
export const CustomerRoute = () => SetMetadata(CUSTOMER_KEY, true);

/** Accepts an Idempotency-Key header; replays the original response for a repeat. */
export const Idempotent = (scope: string) => SetMetadata(IDEMPOTENT_KEY, scope);

export const CurrentActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestActor => ctx.switchToHttp().getRequest().actor,
);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestTenant => ctx.switchToHttp().getRequest().tenant,
);

export const RequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().requestId,
);

/** Resolved from Accept-Language, then the customer's stored language, then Uzbek. */
export const Lang = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): 'uz' | 'ru' | 'en' =>
    ctx.switchToHttp().getRequest().language ?? 'uz',
);
