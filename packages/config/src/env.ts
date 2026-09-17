import { z } from 'zod';

/**
 * Environment schema.
 *
 * The app refuses to boot on invalid configuration rather than failing later with a
 * confusing runtime error. Production additionally refuses the development defaults for
 * anything security-relevant — a missing secret must never silently become "dev-secret".
 */

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('BizBot OS'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- API ---
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_HOST: z.string().default('0.0.0.0'),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    API_GLOBAL_PREFIX: z.string().default('v1'),

    // --- Surfaces (used for CORS and for links sent to customers) ---
    ADMIN_URL: z.string().url().default('http://localhost:3001'),
    MINIAPP_URL: z.string().url().default('http://localhost:3002'),
    WEB_URL: z.string().url().default('http://localhost:3000'),

    // --- Data ---
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    // --- Auth ---
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** AES-256-GCM key for the integration secret vault: 32 bytes, hex or base64. */
    SECRETS_ENCRYPTION_KEY: z.string().min(32),

    // --- Telegram ---
    TELEGRAM_MODE: z.enum(['webhook', 'polling', 'disabled']).default('polling'),
    TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
    /** Public base for webhook registration; must be https and reachable by Telegram. */
    TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),

    // --- Storage ---
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./uploads'),
    STORAGE_PUBLIC_URL: z.string().url().default('http://localhost:4000/files'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // --- Queues ---
    QUEUE_PREFIX: z.string().default('bizbot'),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    /** Run queue processors inside the API process. Convenient locally, never in prod. */
    RUN_WORKER_IN_API: booleanish.default('false'),

    // --- Behaviour flags ---
    ENABLE_DEMO_MODE: booleanish.default('true'),
    ENABLE_SWAGGER: booleanish.default('true'),
    RATE_LIMIT_ENABLED: booleanish.default('true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const requireDistinct: [keyof typeof env, string][] = [
      ['JWT_ACCESS_SECRET', 'JWT access secret'],
      ['JWT_REFRESH_SECRET', 'JWT refresh secret'],
      ['SECRETS_ENCRYPTION_KEY', 'secrets encryption key'],
    ];
    for (const [key, label] of requireDistinct) {
      const value = String(env[key]);
      if (/^(dev|test|change|secret|password|example)/i.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${label} looks like a development placeholder; set a real secret in production.`,
        });
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'Access and refresh secrets must differ, so a leaked access key cannot mint refresh tokens.',
      });
    }
    if (env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_BASE_URL'],
        message: 'Webhook mode requires a public HTTPS base URL for Telegram to call.',
      });
    }
    if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BUCKET'],
        message: 'S3 storage requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
      });
    }
    if (env.RUN_WORKER_IN_API) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RUN_WORKER_IN_API'],
        message: 'Run the worker as its own process in production so a slow job cannot stall HTTP.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: forget the cached env between suites. */
export function resetEnvCache(): void {
  cached = null;
}
