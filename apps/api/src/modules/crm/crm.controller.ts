import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersSchema,
  createTagSchema,
  createNoteSchema,
  adjustLoyaltySchema,
} from '@bizbot/contracts';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { CustomersService } from './customers.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

@Controller('t/:tenantId/customers')
@RequireModule('CRM')
export class CrmController {
  constructor(
    private readonly customers: CustomersService,
    private readonly loyalty: LoyaltyService,
  ) {}

  @Get()
  @RequirePermission('customer:read')
  list(@Query(zodQuery(listCustomersSchema)) query: Record<string, unknown>) {
    return this.customers.list(query);
  }

  @Get('segments')
  @RequirePermission('customer:read')
  segments() {
    return this.customers.listSegments();
  }

  @Get('tags')
  @RequirePermission('customer:read')
  tags() {
    return this.customers.listTags();
  }

  @Post('tags')
  @RequirePermission('customer:write')
  createTag(@Body(zodBody(createTagSchema)) dto: { name: string; color: string }) {
    return this.customers.createTag(dto.name, dto.color);
  }

  @Get(':id')
  @RequirePermission('customer:read')
  detail(@Param('id') id: string) {
    return this.customers.detail(id);
  }

  @Get(':id/timeline')
  @RequirePermission('customer:read')
  timeline(@Param('id') id: string, @Query() query: { page?: number; pageSize?: number }) {
    return this.customers.timeline(id, query);
  }

  @Get(':id/loyalty')
  @RequireModule('LOYALTY')
  @RequirePermission('loyalty:read')
  loyaltyHistory(@Param('id') id: string, @Query() query: { page?: number; pageSize?: number }) {
    return this.loyalty.transactions(id, query);
  }

  @Post(':id/loyalty/adjust')
  @RequireModule('LOYALTY')
  @RequirePermission('loyalty:adjust')
  adjustLoyalty(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(adjustLoyaltySchema.omit({ customerId: true })))
    dto: { amount: number; reason: string },
  ) {
    return this.loyalty.adjust(actor.userId!, id, dto.amount, dto.reason);
  }

  @Post()
  @RequirePermission('customer:write')
  create(
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(createCustomerSchema)) dto: Record<string, unknown>,
  ) {
    return this.customers.create(actor.userId!, dto);
  }

  @Patch(':id')
  @RequirePermission('customer:write')
  update(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateCustomerSchema)) dto: Record<string, unknown>,
  ) {
    return this.customers.update(actor.userId!, id, dto);
  }

  @Post(':id/notes')
  @RequirePermission('customer:write')
  addNote(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(createNoteSchema)) dto: { body: string; isPinned: boolean },
  ) {
    return this.customers.addNote(actor.userId!, id, dto.body, dto.isPinned);
  }
}
