import pino from 'pino';
import { LoggerService } from '@nestjs/common';

/**
 * Structured logging.
 *
 * Redaction is not optional: a bot token or an initData string in a log line is a
 * credential leak with a long tail, because logs are shipped, indexed and retained far
 * beyond the systems that produced them.
 */
const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'token',
  'botToken',
  'accessToken',
  'refreshToken',
  'secret',
  'secrets',
  'authorization',
  'cookie',
  'initData',
  'signature',
  'card',
  'cardNumber',
  'cvv',
  'secretCipher',
  'apiKey',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      ...REDACTED_KEYS,
      ...REDACTED_KEYS.map((k) => `*.${k}`),
      ...REDACTED_KEYS.map((k) => `*.*.${k}`),
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-telegram-bot-api-secret-token"]',
    ],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});

/** Adapts pino to Nest's LoggerService so framework logs share the same stream. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    logger.trace({ context }, String(message));
  }
}
