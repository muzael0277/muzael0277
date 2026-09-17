import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { InfraModule } from './infra/infra.module';
import { AuditModule } from './modules/audit/audit.module';
import { EventsModule } from './modules/events/events.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { MembersModule } from './modules/members/members.module';
import { HealthModule } from './modules/health/health.module';
import { BusinessModule } from './modules/business.module';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ModuleGuard } from './common/guards/module.guard';
import { PlatformGuard } from './common/guards/platform.guard';
import { TenantContextInterceptor } from './common/guards/tenant-context.interceptor';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { RequestContextMiddleware } from './common/interceptors/request-context.middleware';

/**
 * The guard chain runs in registration order, and the order is the security design:
 *
 *   JwtAuthGuard    who is this?                    (401 if unknown)
 *   TenantGuard     whose data, and are they in?    (403 if not a member)
 *   PermissionsGuard may they do this?              (403 if not permitted)
 *   ModuleGuard     is the feature even on?         (403 MODULE_DISABLED)
 *   PlatformGuard   cross-tenant surface            (403 + audit entry)
 *
 * TenantContextInterceptor then carries the resolved tenant into AsyncLocalStorage, so
 * the Prisma guard can scope every query without a single service passing a tenantId
 * around (docs/architecture/02-tenant-isolation.md).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    InfraModule,
    AuditModule,
    EventsModule,
    AuthModule,
    TenantsModule,
    MembersModule,
    BusinessModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ModuleGuard },
    { provide: APP_GUARD, useClass: PlatformGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
