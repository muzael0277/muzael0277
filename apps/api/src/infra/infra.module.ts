import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { TenantCache } from './tenant-cache.service';
import { VaultService } from './vault.service';
import { RouteAuditService } from './route-audit.service';
import { QueueService } from './queue.service';

/**
 * Global so domain modules inject infrastructure without re-importing it everywhere.
 * Nothing with business logic belongs here.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PrismaService, RedisService, TenantCache, VaultService, QueueService, RouteAuditService],
  exports: [PrismaService, RedisService, TenantCache, VaultService, QueueService],
})
export class InfraModule {}
