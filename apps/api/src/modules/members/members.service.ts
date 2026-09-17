import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { canAssignRole, ROLE_LABELS, type Role } from '@bizbot/rbac';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Team management.
 *
 * Two rules here exist to prevent a business from locking itself out or escalating
 * privileges, and both are enforced server-side because a client check is not a control:
 *
 *  • The last OWNER cannot be demoted or removed.
 *  • Nobody may assign a role at or above their own rank.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    const members = await this.prisma.client.tenantMembership.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });

    // Users are platform-level, so their profiles are read outside tenant scope.
    const users = await this.prisma.system('members-profiles', () =>
      this.prisma.raw.user.findMany({
        where: { id: { in: members.map((m) => m.userId) } },
        select: {
          id: true,
          email: true,
          lastLoginAt: true,
          profile: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
    );
    const byId = new Map(users.map((u) => [u.id, u]));

    return members.map((m) => {
      const user = byId.get(m.userId);
      return {
        id: m.id,
        userId: m.userId,
        role: m.role,
        roleLabel: ROLE_LABELS[m.role as Role],
        isActive: m.isActive,
        employeeId: m.employeeId,
        joinedAt: m.createdAt,
        email: user?.email ?? null,
        firstName: user?.profile?.firstName ?? '',
        lastName: user?.profile?.lastName ?? null,
        avatarUrl: user?.profile?.avatarUrl ?? null,
        lastLoginAt: user?.lastLoginAt ?? null,
      };
    });
  }

  async invite(
    tenantId: string,
    actor: { userId: string; role: Role },
    input: { email: string; role: Role; employeeId?: string },
  ) {
    if (!canAssignRole(actor.role, input.role)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'You cannot grant a role at or above your own', {
        yourRole: actor.role,
        requestedRole: input.role,
      });
    }

    const email = input.email.toLowerCase();

    const existingMember = await this.prisma.system('invite-existing-check', async () => {
      const user = await this.prisma.raw.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (!user) return null;
      return this.prisma.raw.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user.id } },
        select: { id: true },
      });
    });
    if (existingMember) {
      throw new DomainError(ErrorCode.CONFLICT, 'This person is already a member of the business');
    }

    const token = randomBytes(32).toString('base64url');
    const invite = await this.prisma.client.memberInvite.create({
      data: {
        tenantId,
        email,
        role: input.role,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        invitedById: actor.userId,
        employeeId: input.employeeId,
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      },
    });

    await this.audit.record({
      tenantId,
      actorUserId: actor.userId,
      action: 'member.invited',
      entityType: 'INVITE',
      entityId: invite.id,
      after: { email, role: input.role },
    });

    // The raw token is returned once so the caller can build the invite link, and is
    // never stored or retrievable afterwards.
    return { id: invite.id, email, role: invite.role, expiresAt: invite.expiresAt, token };
  }

  async changeRole(
    tenantId: string,
    actor: { userId: string; role: Role },
    membershipId: string,
    newRole: Role,
  ) {
    const membership = await this.prisma.client.tenantMembership.findFirstOrThrow({
      where: { id: membershipId, tenantId },
    });

    if (
      !canAssignRole(actor.role, newRole) ||
      !canAssignRole(actor.role, membership.role as Role)
    ) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'You cannot change this member to that role');
    }

    if (membership.role === 'OWNER' && newRole !== 'OWNER') {
      await this.assertNotLastOwner(tenantId, membershipId);
    }

    const updated = await this.prisma.client.tenantMembership.update({
      where: { id: membershipId },
      data: { role: newRole },
    });

    await this.audit.record({
      tenantId,
      actorUserId: actor.userId,
      action: 'member.role_changed',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      before: { role: membership.role },
      after: { role: newRole },
    });
    return updated;
  }

  async remove(tenantId: string, actor: { userId: string; role: Role }, membershipId: string) {
    const membership = await this.prisma.client.tenantMembership.findFirstOrThrow({
      where: { id: membershipId, tenantId },
    });

    if (membership.role === 'OWNER') await this.assertNotLastOwner(tenantId, membershipId);
    if (!canAssignRole(actor.role, membership.role as Role)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'You cannot remove a member of that role');
    }

    await this.prisma.client.tenantMembership.delete({ where: { id: membershipId } });
    await this.audit.record({
      tenantId,
      actorUserId: actor.userId,
      action: 'member.removed',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      before: { role: membership.role },
    });
  }

  /**
   * A business with no owner cannot be administered, billed or deleted by anyone — and
   * no support flow can recover it cleanly. So this is refused at the last owner, not
   * the last member.
   */
  private async assertNotLastOwner(tenantId: string, excludingMembershipId: string) {
    const otherOwners = await this.prisma.client.tenantMembership.count({
      where: { tenantId, role: 'OWNER', isActive: true, id: { not: excludingMembershipId } },
    });
    if (otherOwners === 0) {
      throw new DomainError(
        ErrorCode.LAST_OWNER,
        'A business must always have at least one owner. Promote someone else first.',
      );
    }
  }
}
