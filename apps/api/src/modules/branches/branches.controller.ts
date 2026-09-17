import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { createBranchSchema, createEmployeeSchema } from '@bizbot/contracts';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { BranchesService } from './branches.service';

@Controller('t/:tenantId/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission('branch:read')
  list() { return this.branches.listBranches(); }

  @Post()
  @RequireModule('BRANCHES')
  @RequirePermission('branch:write')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createBranchSchema)) dto: Record<string, unknown>) {
    return this.branches.createBranch(actor.userId!, dto);
  }

  @Patch(':id')
  @RequireModule('BRANCHES')
  @RequirePermission('branch:write')
  update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.branches.updateBranch(id, dto);
  }

  @Delete(':id')
  @RequireModule('BRANCHES')
  @RequirePermission('branch:write')
  @HttpCode(204)
  remove(@Param('id') id: string) { return this.branches.deleteBranch(id); }
}

@Controller('t/:tenantId/employees')
@RequireModule('EMPLOYEES')
export class EmployeesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission('employee:read')
  list() { return this.branches.listEmployees(); }

  @Get(':id')
  @RequirePermission('employee:read')
  detail(@Param('id') id: string) { return this.branches.employeeDetail(id); }

  @Post()
  @RequirePermission('employee:write')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createEmployeeSchema)) dto: never) {
    return this.branches.createEmployee(actor.userId!, dto);
  }

  @Patch(':id')
  @RequirePermission('employee:write')
  update(@Param('id') id: string, @Body() dto: never) {
    return this.branches.updateEmployee(id, dto);
  }

  @Delete(':id')
  @RequirePermission('employee:write')
  @HttpCode(204)
  deactivate(@Param('id') id: string) { return this.branches.deactivateEmployee(id); }
}
