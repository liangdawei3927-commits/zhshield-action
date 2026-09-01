import { defineConfig } from 'vitest/config';
import { detectMachineProfile } from '@zh/shared';

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

const envRaw = process.env.ZH_VITEST_MAX_WORKERS;
const envMax = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
const maxWorkers = Number.isFinite(envMax)
  ? clamp(envMax, 1, 4)
  : detectMachineProfile().vitestMaxWorkers;

export default defineConfig({
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    pool: 'forks',
    maxWorkers,
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
});
