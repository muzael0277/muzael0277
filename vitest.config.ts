import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.spec.ts'],
    // packages/database has its own config: it needs a dedicated test database and
    // serial execution, so running it from here as well would let two suites share
    // fixtures and delete each other's rows.
    exclude: ['**/node_modules/**', 'packages/database/**'],
    environment: 'node',
    globals: false,
  },
});
