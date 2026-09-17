import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Suites share one database, so parallel files would delete each other's fixtures.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 40000,
  },
});
