import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { upsertIntegrationSchema } from '@bizbot/contracts';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { IntegrationsService } from './integrations.service';

@Controller('t/:tenantId/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @RequirePermission('integration:read')
  list() {
    return this.integrations.list();
  }

  /** Owner-only: this is the endpoint that accepts payment credentials. */
  @Post()
  @RequirePermission('integration:write')
  upsert(@CurrentActor() actor: RequestActor, @Body(zodBody(upsertIntegrationSchema)) dto: never) {
    return this.integrations.upsert(actor.userId!, dto);
  }

  @Delete(':id')
  @RequirePermission('integration:write')
  @HttpCode(204)
  remove(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.integrations.remove(actor.userId!, id);
  }
}
