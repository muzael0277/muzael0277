import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestPinoLogger, logger } from './common/logger';
import { EventDispatcher } from './modules/events/event-dispatcher.service';

/**
 * The worker.
 *
 * Not a second service — the same application, the same DI container, the same domain
 * services, started without an HTTP listener (docs/adr/0001-modular-monolith.md). That
 * is what keeps background work and request handling from drifting apart, while still
 * letting a slow job run on its own process and scale separately.
 */
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this as unknown as bigint);
};

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new NestPinoLogger(),
  });
  app.enableShutdownHooks();

  const dispatcher = app.get(EventDispatcher);
  logger.info('BizBot OS worker started');

  // Drain once at boot so events queued while the worker was down are picked up
  // immediately rather than waiting for the first tick.
  await dispatcher.drain().catch((error) => logger.error({ err: error }, 'Initial drain failed'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start worker');
  process.exit(1);
});
