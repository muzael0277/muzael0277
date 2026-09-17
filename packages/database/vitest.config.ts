import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // These tests share one database; running files in parallel would let one suite's
    // cleanup delete another's fixtures.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
