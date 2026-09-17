import { Controller, Get, Query } from '@nestjs/common';
import { analyticsRangeSchema } from '@bizbot/contracts';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { Lang, RequireModule, RequirePermission } from '../../common/decorators';

import { AnalyticsService } from './analytics.service';

@Controller('t/:tenantId/analytics')
@RequireModule('ANALYTICS')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  @RequirePermission('analytics:read')
  dashboard(
    @Query(zodQuery(analyticsRangeSchema)) query: never,
    @Lang() lang: 'uz' | 'ru' | 'en',
  ) {
    return this.analytics.dashboard(query, lang);
  }

  /** Observations derived from the same stored numbers the dashboard shows. */
  @Get('insights')
  @RequirePermission('analytics:read')
  insights(@Lang() lang: 'uz' | 'ru' | 'en') {
    return this.analytics.businessHealth(lang);
  }
}
