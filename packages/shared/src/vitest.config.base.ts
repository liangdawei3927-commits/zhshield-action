import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import path from 'path';
import { detectMachineProfile } from './machine-profile';

/** Absolute path to the monorepo `packages/` directory. */
export const packagesDir = path.resolve(__dirname, '..', '..');

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/**
 * vitest 最大 worker 数：优先读环境变量 ZH_VITEST_MAX_WORKERS（clamp 1..4），
 * 否则回退到机器画像（低配 2，否则 cores-1 封顶 4）。低配机避免同机并行打满内存（OOM/彩球）。
 */
export function resolveVitestMaxWorkers(): number {
  const envRaw = process.env.ZH_VITEST_MAX_WORKERS;
  const envMax = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
  if (Number.isFinite(envMax)) {
    return clamp(envMax, 1, 4);
  }
  return detectMachineProfile().vitestMaxWorkers;
}

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
      pool: 'forks',
      maxWorkers: resolveVitestMaxWorkers(),
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
