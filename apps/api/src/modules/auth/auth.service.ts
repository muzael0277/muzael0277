import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DomainError, ErrorCode, type Language } from '@bizbot/shared';
import type { RegisterInput } from '@bizbot/contracts';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { AuditService } from '../audit/audit.service';
import { TokenService, type TokenPair } from './token.service';

/**
 * Authentication.
 *
 * Password hashing is argon2id at parameters that make offline cracking expensive; the
 * defaults here are deliberate, not copied. Login throttling is per (email, IP) with an
 * account-level lockout, and the error is always the same regardless of whether the
 * email exists — user enumeration is a real attack, not a theoretical one.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthResult extends TokenPair {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string | null;
    language: string;
    platformRole: string;
  };
  tenants: { id: string; slug: string; name: string; role: string; logoUrl: string | null }[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, context: { ip?: string; userAgent?: string }): Promise<AuthResult> {
    const email = input.email.toLowerCase();

    const existing = await this.prisma.system('register-check', () =>
      this.prisma.raw.user.findUnique({ where: { email }, select: { id: true } }),
    );
    if (existing) throw new DomainError(ErrorCode.EMAIL_ALREADY_REGISTERED);

    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    const user = await this.prisma.system('register-create', () =>
      this.prisma.raw.user.create({
        data: {
          email,
          passwordHash,
          profile: {
            create: {
              firstName: input.firstName,
              lastName: input.lastName,
              phone: input.phone,
              language: (input.language as Language) ?? 'uz',
            },
          },
        },
        include: { profile: true },
      }),
    );

    await this.audit.record({
      actorUserId: user.id, action: 'auth.registered', entityType: 'USER', entityId: user.id,
      ip: context.ip, userAgent: context.userAgent,
    });

    const pair = await this.tokens.issueForUser(user, context);
    return {
      ...pair,
      user: {
        id: user.id, email: user.email,
        firstName: user.profile!.firstName, lastName: user.profile!.lastName,
        language: user.profile!.language, platformRole: user.platformRole,
      },
      tenants: [],
    };
  }

  async login(
    email: string,
    password: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const normalizedEmail = email.toLowerCase();
    await this.assertNotThrottled(normalizedEmail, context.ip);

    const user = await this.prisma.system('login-lookup', () =>
      this.prisma.raw.user.findUnique({
        where: { email: normalizedEmail },
        include: {
          profile: true,
          memberships: {
            where: { isActive: true },
            include: { tenant: { select: { id: true, slug: true, name: true, logoUrl: true, status: true } } },
          },
        },
      }),
    );

    // Hash a dummy password when the user does not exist, so a missing account and a
    // wrong password take the same time. Otherwise the response time is an oracle.
    if (!user) {
      await argon2.hash(password, ARGON2_OPTIONS).catch(() => undefined);
      await this.recordFailedAttempt(normalizedEmail, context.ip);
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(ErrorCode.ACCOUNT_LOCKED, undefined, { until: user.lockedUntil });
    }

    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      await this.recordFailedAttempt(normalizedEmail, context.ip);
      await this.registerFailureOnUser(user.id, user.failedLoginAttempts);
      await this.audit.record({
        actorUserId: user.id, action: 'auth.login_failed',
        entityType: 'USER', entityId: user.id, ip: context.ip, userAgent: context.userAgent,
      });
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS);
    }

    if (!user.isActive) throw new DomainError(ErrorCode.FORBIDDEN, 'Account is disabled');

    await this.clearAttempts(normalizedEmail, context.ip);
    await this.prisma.system('login-success', () =>
      this.prisma.raw.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
      }),
    );

    await this.audit.record({
      actorUserId: user.id, action: 'auth.login', entityType: 'USER', entityId: user.id,
      ip: context.ip, userAgent: context.userAgent,
    });

    const pair = await this.tokens.issueForUser(user, context);
    return {
      ...pair,
      user: {
        id: user.id, email: user.email,
        firstName: user.profile?.firstName ?? '', lastName: user.profile?.lastName ?? null,
        language: user.profile?.language ?? 'uz', platformRole: user.platformRole,
      },
      tenants: user.memberships
        .filter((m) => m.tenant.status !== 'DELETED')
        .map((m) => ({
          id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name,
          role: m.role, logoUrl: m.tenant.logoUrl,
        })),
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.system('change-password-lookup', () =>
      this.prisma.raw.user.findUniqueOrThrow({ where: { id: userId } }),
    );

    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new DomainError(ErrorCode.INVALID_CREDENTIALS);

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    await this.prisma.system('change-password', () =>
      this.prisma.raw.user.update({ where: { id: userId }, data: { passwordHash } }),
    );

    // Every other session dies: a password change is usually a response to compromise.
    await this.tokens.revokeAllForUser(userId);
    await this.audit.record({
      actorUserId: userId, action: 'auth.password_changed', entityType: 'USER', entityId: userId,
    });
  }

  // ── throttling ───────────────────────────────────────────────────────────────

  private attemptKey(email: string, ip?: string) {
    return `login:attempts:${email}:${ip ?? 'unknown'}`;
  }

  private async assertNotThrottled(email: string, ip?: string): Promise<void> {
    const attempts = Number((await this.redis.client.get(this.attemptKey(email, ip))) ?? 0);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      throw new DomainError(ErrorCode.ACCOUNT_LOCKED, undefined, { retryAfterMinutes: LOCKOUT_MINUTES });
    }
  }

  private async recordFailedAttempt(email: string, ip?: string): Promise<void> {
    const key = this.attemptKey(email, ip);
    const attempts = await this.redis.client.incr(key);
    if (attempts === 1) await this.redis.client.expire(key, LOCKOUT_MINUTES * 60);
  }

  private async clearAttempts(email: string, ip?: string): Promise<void> {
    await this.redis.forget(this.attemptKey(email, ip));
  }

  /**
   * A second counter on the user row, so an attacker spreading attempts across many IPs
   * still trips a lockout — Redis alone is per-IP and would not catch that.
   */
  private async registerFailureOnUser(userId: string, current: number): Promise<void> {
    const next = current + 1;
    await this.prisma.system('login-failure-counter', () =>
      this.prisma.raw.user.update({
        where: { id: userId },
        data: {
          failedLoginAttempts: next,
          lockedUntil: next >= MAX_LOGIN_ATTEMPTS * 2
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : undefined,
        },
      }),
    );
  }
}
