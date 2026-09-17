import { Controller, Get, HttpCode } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';

/**
 * Liveness answers "is the process up"; readiness answers "can it serve traffic".
 * Conflating them makes a load balancer kill a pod that is merely waiting on a database.
 * Neither exposes version numbers or configuration — those help an attacker, not an
 * operator (docs/architecture/10-security.md).
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Public()
  @Get('readiness')
  @HttpCode(200)
  async readiness() {
    const [database, cache] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const ready = database && cache;
    return { status: ready ? 'ready' : 'degraded', checks: { database, cache } };
  }
}
