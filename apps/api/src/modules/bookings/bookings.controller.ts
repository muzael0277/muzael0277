import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  availabilityQuerySchema,
  createBookingSchema,
  listBookingsSchema,
  updateBookingStatusSchema,
} from '@bizbot/contracts';
import type { BookingStatus } from '@bizbot/database';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { BookingsService } from './bookings.service';

@Controller('t/:tenantId/bookings')
@RequireModule('BOOKING')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('availability')
  @RequirePermission('booking:read')
  availability(@Query(zodQuery(availabilityQuerySchema)) query: never) {
    return this.bookings.getAvailability(query);
  }

  @Get()
  @RequirePermission('booking:read')
  list(@Query(zodQuery(listBookingsSchema)) query: Record<string, unknown>) {
    return this.bookings.list(query);
  }

  @Get(':id')
  @RequirePermission('booking:read')
  detail(@Param('id') id: string) {
    return this.bookings.detail(id);
  }

  @Post()
  @RequirePermission('booking:write')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createBookingSchema)) dto: never) {
    return this.bookings.create(dto, { userId: actor.userId });
  }

  @Patch(':id/status')
  @RequirePermission('booking:write')
  updateStatus(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateBookingStatusSchema)) dto: { status: BookingStatus; comment?: string },
  ) {
    return this.bookings.updateStatus(id, dto.status, { userId: actor.userId }, dto.comment);
  }
}
