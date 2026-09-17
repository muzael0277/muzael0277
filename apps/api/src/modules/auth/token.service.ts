import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { loadEnv } from '@bizbot/config';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../common/logger';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Access and refresh tokens.
 *
 * Refresh tokens are random (not JWTs), stored only as a SHA-256 hash, and rotated on
 * every use. `familyId` links a rotation chain: presenting an already-consumed token
 * means either a replay or a stolen token, and the only safe response is to revoke the
 * entire family — the legitimate user is logged out, which is the correct trade against
 * an attacker holding a valid session (docs/architecture/10-security.md).
 */
@Injectable()
export class TokenService {
  private readonly env = loadEnv();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async issueForUser(
    user: { id: string; email: string; platformRole: string },
    context: { ip?: string; userAgent?: string; familyId?: string },
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, platformRole: user.platformRole },
      { audience: 'staff', expiresIn: this.env.JWT_ACCESS_TTL, secret: this.env.JWT_ACCESS_SECRET },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.JWT_REFRESH_TTL_DAYS * 86400_000);

    await this.prisma.system('issue-refresh-token', () =>
      this.prisma.raw.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(refreshToken),
          familyId: context.familyId ?? randomUUID(),
          expiresAt,
          ip: context.ip,
          userAgent: context.userAgent?.slice(0, 255),
        },
      }),
    );

    return { accessToken, refreshToken, expiresIn: parseTtlSeconds(this.env.JWT_ACCESS_TTL) };
  }

  /** Customer sessions are short-lived and carry their tenant, so they cannot be reused elsewhere. */
  async issueForCustomer(customer: {
    id: string;
    tenantId: string;
  }): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.jwt.signAsync(
      { sub: customer.id, tenantId: customer.tenantId },
      { audience: 'customer', expiresIn: '12h', secret: this.env.JWT_ACCESS_SECRET },
    );
    return { accessToken, expiresIn: 12 * 3600 };
  }

  async rotate(
    presented: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const tokenHash = hashToken(presented);

    const stored = await this.prisma.system('rotate-refresh-token', () =>
      this.prisma.raw.refreshToken.findUnique({
        where: { tokenHash },
        include: {
          user: { select: { id: true, email: true, platformRole: true, isActive: true } },
        },
      }),
    );

    if (!stored) throw new DomainError(ErrorCode.TOKEN_INVALID);

    if (stored.consumedAt || stored.revokedAt) {
      // Reuse detection. A consumed token in the wild means it was captured, so the whole
      // family dies — including whatever the attacker is holding.
      await this.revokeFamily(stored.familyId, 'refresh-token-reuse');
      await this.audit.record({
        actorUserId: stored.userId,
        action: 'auth.refresh_token_reused',
        entityType: 'USER',
        entityId: stored.userId,
        ip: context.ip,
        userAgent: context.userAgent,
      });
      logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'Refresh token reuse detected',
      );
      throw new DomainError(ErrorCode.REFRESH_TOKEN_REUSED);
    }

    if (stored.expiresAt < new Date()) throw new DomainError(ErrorCode.TOKEN_EXPIRED);
    if (!stored.user.isActive) throw new DomainError(ErrorCode.FORBIDDEN, 'Account is disabled');

    await this.prisma.system('consume-refresh-token', () =>
      this.prisma.raw.refreshToken.update({
        where: { id: stored.id },
        data: { consumedAt: new Date() },
      }),
    );

    return this.issueForUser(stored.user, { ...context, familyId: stored.familyId });
  }

  async revoke(presented: string): Promise<void> {
    await this.prisma.system('revoke-refresh-token', () =>
      this.prisma.raw.refreshToken.updateMany({
        where: { tokenHash: hashToken(presented), revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async revokeFamily(familyId: string, _reason: string): Promise<void> {
    await this.prisma.system('revoke-token-family', () =>
      this.prisma.raw.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Logs the user out everywhere — used on password change. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.system('revoke-all-tokens', () =>
      this.prisma.raw.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit!] ?? 60);
}
