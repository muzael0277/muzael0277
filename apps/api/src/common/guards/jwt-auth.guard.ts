import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { CUSTOMER_KEY, PUBLIC_KEY } from '../decorators';

export interface StaffTokenPayload {
  sub: string;
  aud: 'staff';
  platformRole: 'NONE' | 'SUPPORT' | 'ADMIN';
  email: string;
}

export interface CustomerTokenPayload {
  sub: string;
  aud: 'customer';
  tenantId: string;
}

/**
 * Authentication.
 *
 * Staff and customer tokens carry different audiences and are checked against the route's
 * declared audience. A customer token is therefore rejected by every staff route even if
 * the URL is guessed correctly — the separation is enforced by the claim, not by the path
 * naming convention (docs/architecture/02-tenant-isolation.md, layer ①).
 *
 * Deliberately, a staff access token carries no tenant or role. Memberships are resolved
 * per request, so revoking someone's access takes effect immediately rather than when
 * their 15-minute token happens to expire.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request);

    // @Public means "a session is not required", not "a session is ignored". A public
    // route that behaves differently for a signed-in caller — /auth/me probing session
    // validity, a public catalog personalising for a known customer — needs the actor
    // populated when a valid token happens to be present. Treating the two as the same
    // thing made /auth/me unable to see its own caller.
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler)) {
      if (token) await this.tryAttachActor(request, token);
      return true;
    }

    if (!token) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Missing bearer token');

    const isCustomerRoute = this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, handler) === true;
    const expectedAudience = isCustomerRoute ? 'customer' : 'staff';

    let payload: StaffTokenPayload | CustomerTokenPayload;
    try {
      payload = await this.jwt.verifyAsync(token, { audience: expectedAudience });
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new DomainError(expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID);
    }

    if (payload.aud !== expectedAudience) {
      throw new DomainError(ErrorCode.TOKEN_INVALID, 'Token audience does not match this route');
    }

    if (payload.aud === 'customer') {
      request.actor = { type: 'CUSTOMER', customerId: payload.sub };
    } else {
      request.actor = {
        type: 'USER',
        userId: payload.sub,
        platformRole: payload.platformRole,
        email: payload.email,
      };
    }
    return true;
  }

  /**
   * Best-effort actor resolution for a public route. A bad or expired token is simply
   * ignored here — the route is public, so an invalid session must not turn a working
   * request into a 401.
   */
  private async tryAttachActor(request: Request, token: string): Promise<void> {
    for (const audience of ['staff', 'customer'] as const) {
      try {
        const payload = await this.jwt.verifyAsync<StaffTokenPayload | CustomerTokenPayload>(
          token,
          { audience },
        );
        request.actor =
          payload.aud === 'customer'
            ? { type: 'CUSTOMER', customerId: payload.sub }
            : {
                type: 'USER',
                userId: payload.sub,
                platformRole: payload.platformRole,
                email: payload.email,
              };
        return;
      } catch {
        // Try the other audience, then give up silently.
      }
    }
  }
}

export function extractBearer(request: Request): string | null {
  const header = request.header('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
