import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';
import { logger } from '../../common/logger';

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Audit log.
 *
 * Append-only at the database level: the table has triggers that refuse UPDATE outright
 * and permit DELETE only for a transaction that explicitly opts in. An attacker holding
 * application credentials cannot erase their own trail.
 *
 * Writing an audit entry must never fail the operation it describes — a logging failure
 * that rolls back a completed order would be a worse bug than the missing log line. So
 * failures here are logged and swallowed, except inside an explicit transaction where
 * the caller has chosen atomicity.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.system('audit-write', () =>
        this.prisma.raw.auditLog.create({
          data: {
            tenantId: entry.tenantId ?? null,
            actorUserId: entry.actorUserId ?? null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            before: entry.before === undefined ? undefined : (entry.before as never),
            after: entry.after === undefined ? undefined : (entry.after as never),
            ip: entry.ip,
            userAgent: entry.userAgent,
            requestId: entry.requestId,
          },
        }),
      );
    } catch (error) {
      logger.error({ err: error, action: entry.action }, 'Failed to write audit entry');
    }
  }

  /** Cross-tenant platform access, recorded before the handler runs. */
  async recordPlatformAccess(input: {
    userId: string;
    action: string;
    path: string;
    ip?: string;
    userAgent?: string;
    requestId?: string;
  }): Promise<void> {
    await this.record({
      actorUserId: input.userId,
      action: input.action,
      entityType: 'PLATFORM',
      after: { path: input.path },
      ip: input.ip,
      userAgent: input.userAgent,
      requestId: input.requestId,
    });
  }

  /**
   * Diffs two entities and records only the changed fields.
   * Storing whole rows would bloat the table and, worse, copy secrets into it.
   */
  async recordChange(
    entry: Omit<AuditEntry, 'before' | 'after'>,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    sensitiveKeys: string[] = ['passwordHash', 'botTokenCipher', 'secretCipher'],
  ): Promise<void> {
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (sensitiveKeys.includes(key)) {
        if (before[key] !== after[key]) {
          changedBefore[key] = '[redacted]';
          changedAfter[key] = '[redacted]';
        }
        continue;
      }
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changedBefore[key] = before[key];
        changedAfter[key] = after[key];
      }
    }

    if (Object.keys(changedAfter).length === 0) return;
    await this.record({ ...entry, before: changedBefore, after: changedAfter });
  }
}
