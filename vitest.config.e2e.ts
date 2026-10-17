import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * End-to-end configuration.
 *
 * These suites boot real Postgres and Redis containers through
 * Testcontainers, so they run serially with a generous timeout — the point
 * is to exercise transactions, row locks and Lua scripts against the real
 * engines, which an in-memory fake cannot do.
 */
export default defineConfig({
  // Path aliases come from tsconfig natively; no plugin needed.
  resolve: { tsconfigPaths: true },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          useDefineForClassFields: false,
        },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Containers are expensive; one worker keeps port and resource usage sane.
    fileParallelism: false,
    pool: 'forks',
  },
});
