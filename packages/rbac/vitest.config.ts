import { defineConfig } from 'vitest/config';

// Own config so `pnpm --filter <pkg> test` runs this package's tests rather than
// resolving the workspace-root config, whose globs are relative to the root.
export default defineConfig({
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
