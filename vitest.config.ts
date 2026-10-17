import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Unit-test configuration.
 *
 * `unplugin-swc` is not optional for a Nest code base: Vitest transforms
 * with esbuild, and esbuild cannot emit `design:paramtypes`. Without SWC,
 * every provider that is injected *by type* resolves to `undefined` and
 * `Test.createTestingModule` fails with "Nest can't resolve dependencies"
 * — in the tests only, which makes it a deeply confusing afternoon.
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
    include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-spec.ts'],
    environment: 'node',
    // Domain tests are pure and fast; isolate per file so a leaked singleton
    // in one suite cannot change the outcome of another.
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['libs/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        '**/index.ts',
        '**/*.module.ts',
        '**/main.ts',
        '**/migrations/**',
        '**/*.dto.ts',
        '**/*.entity.ts',
      ],
      thresholds: {
        // The domain layer is where the money logic lives; it carries the bar.
        'libs/kernel/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
      },
    },
  },
});
