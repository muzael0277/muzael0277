import { describe, it, expect, beforeEach } from 'vitest';
import { envSchema, loadEnv, resetEnvCache } from '../env';

/**
 * The environment schema is the first thing that runs and the first thing that can stop
 * the process. Each case below is a boot failure that happened.
 */

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: 'R7qN4vK2mX9tB6wL1pH8sJ3dF5gC0aY2zQ1w',
  JWT_REFRESH_SECRET: 'K2mX9tB6wL1pH8sJ3dF5gC0aY2zQ1wR7qN4v',
  SECRETS_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

beforeEach(() => resetEnvCache());

describe('optional settings that arrive empty', () => {
  it('treats an empty webhook URL as unset', () => {
    // Compose renders an unset variable as '', and `.url().optional()` rejects '' rather
    // than skipping it — so `docker compose up` refused to boot the API for anyone who
    // had not filled in a webhook URL they did not need yet.
    const parsed = envSchema.safeParse({ ...BASE, TELEGRAM_WEBHOOK_BASE_URL: '' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.TELEGRAM_WEBHOOK_BASE_URL).toBeUndefined();
  });

  it('treats whitespace the same way', () => {
    expect(envSchema.safeParse({ ...BASE, TELEGRAM_WEBHOOK_BASE_URL: '   ' }).success).toBe(true);
  });

  it('still rejects a URL that is present and wrong', () => {
    // "Unset" is not a licence to accept nonsense.
    expect(envSchema.safeParse({ ...BASE, TELEGRAM_WEBHOOK_BASE_URL: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('accepts a real one', () => {
    const parsed = envSchema.parse({ ...BASE, TELEGRAM_WEBHOOK_BASE_URL: 'https://api.anor.uz' });
    expect(parsed.TELEGRAM_WEBHOOK_BASE_URL).toBe('https://api.anor.uz');
  });

  it('applies the same rule to the empty S3 settings', () => {
    const parsed = envSchema.safeParse({
      ...BASE,
      S3_ENDPOINT: '',
      S3_BUCKET: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('production refuses to start on a careless setting', () => {
  const prod = { ...BASE, NODE_ENV: 'production' as const };

  it('rejects placeholder secrets', () => {
    const parsed = envSchema.safeParse({
      ...prod,
      JWT_ACCESS_SECRET: 'dev-access-secret-please-change-in-production-0001',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects two identical JWT secrets', () => {
    // Otherwise a leaked 15-minute access key also mints 30-day refresh tokens.
    const same = 'R7qN4vK2mX9tB6wL1pH8sJ3dF5gC0aY2zQ1w';
    const parsed = envSchema.safeParse({
      ...prod,
      JWT_ACCESS_SECRET: same,
      JWT_REFRESH_SECRET: same,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects webhook mode without a public URL', () => {
    expect(envSchema.safeParse({ ...prod, TELEGRAM_MODE: 'webhook' }).success).toBe(false);
    expect(
      envSchema.safeParse({
        ...prod,
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_BASE_URL: 'https://api.anor.uz',
      }).success,
    ).toBe(true);
  });

  it('rejects running the worker inside the API', () => {
    // A long job would occupy the event loop that is also answering requests.
    expect(envSchema.safeParse({ ...prod, RUN_WORKER_IN_API: 'true' }).success).toBe(false);
  });

  it('rejects half-configured S3', () => {
    expect(envSchema.safeParse({ ...prod, STORAGE_DRIVER: 's3', S3_BUCKET: '' }).success).toBe(
      false,
    );
  });

  it('allows a correctly configured production environment', () => {
    expect(envSchema.safeParse(prod).success).toBe(true);
  });
});

describe('loadEnv', () => {
  it('names the offending variable rather than failing vaguely', () => {
    expect(() => loadEnv({ ...BASE, DATABASE_URL: 'nonsense' } as never)).toThrow(/DATABASE_URL/);
  });

  it('applies the documented defaults', () => {
    const env = loadEnv(BASE as never);
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.TELEGRAM_MODE).toBe('polling');
  });
});
