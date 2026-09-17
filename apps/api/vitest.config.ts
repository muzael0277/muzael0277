import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // NestJS resolves dependencies from `design:paramtypes`, which esbuild — vitest's
  // default transformer — does not emit. Without SWC every constructor injection in a
  // test is undefined, which looks like a DI bug and is actually a build one.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // The integration suites share one database, so parallel files would let one
    // suite's cleanup delete another's fixtures.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
