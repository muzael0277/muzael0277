import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createTenantSchema, updateTenantSchema, updateTenantSettingsSchema,
  toggleModuleSchema, onboardingAnswersSchema, type CreateTenantInput,
} from '@bizbot/contracts';
import { recommendTemplate, TEMPLATE_DEFINITIONS, type ModuleKey } from '@bizbot/rbac';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  AuthenticatedRoute, CurrentActor, CurrentTenant, Public, RequirePermission,
} from '../../common/decorators';
import type { RequestActor, RequestTenant } from '../../common/types';
import { TenantsService } from './tenants.service';

@Controller()
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  /** The template catalogue drives the onboarding picker; it is not sensitive. */
  @Public()
  @Get('templates')
  listTemplates() {
    return Object.values(TEMPLATE_DEFINITIONS).map((t) => ({
      key: t.key, label: t.label, description: t.description, icon: t.icon,
      examples: t.examples, modules: t.modules,
    }));
  }

  /**
   * Smart onboarding: plain business questions in, a configured system out. Pure
   * computation, so it is safe to call before a tenant exists.
   */
  @AuthenticatedRoute()
  @Post('onboarding/recommend')
  recommend(@Body(zodBody(onboardingAnswersSchema)) answers: Parameters<typeof recommendTemplate>[0]) {
    const result = recommendTemplate(answers);
    return {
      ...result,
      template: TEMPLATE_DEFINITIONS[result.template],
    };
  }

  @AuthenticatedRoute()
  @Post('tenants')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createTenantSchema)) dto: CreateTenantInput) {
    return this.tenants.create(actor.userId!, dto);
  }

  @Get('t/:tenantId')
  @RequirePermission('settings:read', 'customer:read')
  detail(@CurrentTenant() tenant: RequestTenant) {
    return this.tenants.detail(tenant.id);
  }

  @Patch('t/:tenantId')
  @RequirePermission('settings:write')
  update(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(updateTenantSchema)) dto: Record<string, unknown>,
  ) {
    return this.tenants.update(tenant.id, actor.userId!, dto);
  }

  @Patch('t/:tenantId/settings')
  @RequirePermission('settings:write')
  updateSettings(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(updateTenantSettingsSchema)) dto: Record<string, unknown>,
  ) {
    return this.tenants.updateSettings(tenant.id, actor.userId!, dto);
  }

  @Get('t/:tenantId/modules')
  @RequirePermission('settings:read')
  modules(@CurrentTenant() tenant: RequestTenant) {
    return this.tenants.listModules(tenant.id);
  }

  @Patch('t/:tenantId/modules')
  @RequirePermission('settings:write')
  toggleModule(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(toggleModuleSchema)) dto: { module: string; enabled: boolean },
  ) {
    return this.tenants.setModule(tenant.id, actor.userId!, dto.module as ModuleKey, dto.enabled);
  }

  @Patch('t/:tenantId/onboarding')
  @RequirePermission('settings:write')
  onboarding(
    @CurrentTenant() tenant: RequestTenant,
    @Body() body: { step: number; complete?: boolean },
  ) {
    return this.tenants.advanceOnboarding(tenant.id, body.step, body.complete === true);
  }
}
