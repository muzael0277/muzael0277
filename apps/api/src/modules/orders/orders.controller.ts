import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { createOrderSchema, listOrdersSchema, updateOrderStatusSchema } from '@bizbot/contracts';
import type { OrderStatus } from '@bizbot/database';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { OrdersService } from './orders.service';

@Controller('t/:tenantId/orders')
@RequireModule('ORDERS')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermission('order:read')
  list(@Query(zodQuery(listOrdersSchema)) query: Record<string, unknown>) {
    return this.orders.list(query);
  }

  @Get(':id')
  @RequirePermission('order:read')
  detail(@Param('id') id: string) {
    return this.orders.detail(id);
  }

  @Post()
  @RequirePermission('order:write')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createOrderSchema)) dto: never) {
    return this.orders.createByStaff(actor.userId!, dto);
  }

  @Patch(':id/status')
  @RequirePermission('order:status')
  updateStatus(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateOrderStatusSchema)) dto: { status: OrderStatus; comment?: string },
  ) {
    return this.orders.updateStatus(id, dto.status, { userId: actor.userId }, dto.comment);
  }
}
