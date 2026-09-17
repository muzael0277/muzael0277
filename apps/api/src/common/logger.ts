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

/**
 * Pretty output is a development convenience, and `pino-pretty` is a dev dependency —
 * absent from the production image. Asking pino for a transport that is not installed
 * throws at module load, so the whole process dies at boot because it could not make
 * the logs colourful. Check first, and fall back to JSON.
 */
function prettyTransport(): pino.LoggerOptions['transport'] | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } };
}

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
  transport: prettyTransport(),
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
