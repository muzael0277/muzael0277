import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { loadEnv } from '@bizbot/config';
import { AppModule } from './app.module';
import { NestPinoLogger, logger } from './common/logger';

/**
 * BigInt does not survive JSON.stringify, and lifetime money accumulators are BigInt
 * (docs/adr/0006-money-as-integer-minor-units.md). Serialising as Number is safe here
 * because every such value is a minor-unit amount far below 2^53 — and silently throwing
 * on serialisation would be a worse failure than a documented conversion.
 */
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this as unknown as bigint);
};

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: new NestPinoLogger(),
    bodyParser: false,
  });

  // Webhook signatures are computed over the exact bytes received, so the raw body must
  // survive JSON parsing. Reserialising it would change key order and break HMAC checks.
  app.use(
    json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());
  app.use(
    helmet({
      // The Mini App is embedded in Telegram's webview, so a frame-ancestors policy of
      // 'none' would break it outright.
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: [env.ADMIN_URL, env.MINIAPP_URL, env.WEB_URL],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Request-Id',
      'Idempotency-Key',
      'If-Match',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  app.setGlobalPrefix(env.API_GLOBAL_PREFIX, {
    exclude: ['health', 'readiness'],
  });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);
  logger.info(
    { port: env.API_PORT, env: env.NODE_ENV, prefix: env.API_GLOBAL_PREFIX },
    `BizBot OS API listening on http://${env.API_HOST}:${env.API_PORT}/${env.API_GLOBAL_PREFIX}`,
  );
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start API');
  process.exit(1);
});
