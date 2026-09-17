import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, type Observable } from 'rxjs';
import type { Request } from 'express';
import { tenantContext } from '@bizbot/database';

/**
 * Layer ③: carries the resolved tenant into AsyncLocalStorage for the rest of the
 * request, so no service needs a tenantId parameter and the Prisma guard can scope every
 * query without being told.
 *
 * Runs after the guards, which is exactly right: the context is derived from an
 * authorization decision, never from request input.
 *
 * `from(...)` converts the promise back to an Observable. The tenant context must stay
 * active across the whole handler, including the lazy Prisma promises it creates — hence
 * awaiting `lastValueFrom` inside the scope rather than returning the Observable out of it.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId = request.tenant?.id;
    if (!tenantId) return next.handle();

    const actor = request.actor;
    return from(
      tenantContext.run(
        {
          tenantId,
          requestId: request.requestId,
          actor: actor
            ? {
                type: actor.type,
                userId: actor.userId,
                customerId: actor.customerId,
                role: request.tenant?.role,
              }
            : undefined,
        },
        async () => {
          const { lastValueFrom } = await import('rxjs');
          return lastValueFrom(next.handle(), { defaultValue: undefined });
        },
      ),
    );
  }
}
