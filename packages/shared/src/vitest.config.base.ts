import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import path from 'path';

/** Absolute path to the monorepo `packages/` directory. */
export const packagesDir = path.resolve(__dirname, '..', '..');

/**
 * Shared vitest configuration base for all `@zh/*` packages.
 *
 * Each package's `vitest.config.ts` calls this with its own `resolve.alias`
 * map and any package-specific `test` settings (e.g. `testTimeout`, `pool`,
 * `environment`). `mergeConfig` deep-merges the overrides on top of the base,
 * so package-specific values win while the shared test/coverage shape is
 * defined exactly once here.
 */
export function makeVitestConfig(overrides?: ViteUserConfig): ViteUserConfig {
  const base: ViteUserConfig = {
    test: {
      globals: true,
      include: ['src/__tests__/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov', 'json-summary'],
        include: ['src/**/*.ts'],
        exclude: ['src/__tests__/**', 'src/types.ts', 'src/index.ts'],
        thresholds: {
          statements: 50,
          branches: 40,
          functions: 50,
          lines: 50,
        },
      },
    },
  };
  return mergeConfig(base, defineConfig(overrides ?? {}));
}
