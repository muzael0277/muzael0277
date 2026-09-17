import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { inviteMemberSchema, updateMemberRoleSchema } from '@bizbot/contracts';
import { ASSIGNABLE_ROLES, ROLE_LABELS, permissionsForRole, type Role } from '@bizbot/rbac';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, CurrentTenant, RequirePermission } from '../../common/decorators';
import type { RequestActor, RequestTenant } from '../../common/types';
import { MembersService } from './members.service';

@Controller('t/:tenantId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('member:read')
  list(@CurrentTenant() tenant: RequestTenant) {
    return this.members.list(tenant.id);
  }

  /** The admin UI renders the invite picker from this, so it stays in step with the matrix. */
  @Get('roles')
  @RequirePermission('member:read')
  roles() {
    return ASSIGNABLE_ROLES.map((role) => ({
      key: role,
      label: ROLE_LABELS[role],
      permissions: [...permissionsForRole(role)],
    }));
  }

  @Post('invite')
  @RequirePermission('member:invite')
  invite(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(inviteMemberSchema)) dto: { email: string; role: Role; employeeId?: string },
  ) {
    return this.members.invite(
      tenant.id,
      { userId: actor.userId!, role: tenant.role as Role },
      dto,
    );
  }

  @Patch(':membershipId/role')
  @RequirePermission('member:role')
  changeRole(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Param('membershipId') membershipId: string,
    @Body(zodBody(updateMemberRoleSchema)) dto: { role: Role },
  ) {
    return this.members.changeRole(
      tenant.id,
      { userId: actor.userId!, role: tenant.role as Role },
      membershipId,
      dto.role,
    );
  }

  @Delete(':membershipId')
  @RequirePermission('member:role')
  @HttpCode(204)
  remove(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Param('membershipId') membershipId: string,
  ) {
    return this.members.remove(
      tenant.id,
      { userId: actor.userId!, role: tenant.role as Role },
      membershipId,
    );
  }
}
