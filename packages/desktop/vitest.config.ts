import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectMachineProfile } from '@zh/shared';

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

const envRaw = process.env.ZH_VITEST_MAX_WORKERS;
const envMax = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
const maxWorkers = Number.isFinite(envMax)
  ? clamp(envMax, 1, 4)
  : detectMachineProfile().vitestMaxWorkers;

/**
 * 与 `vite.config.ts` 保持同一注入口径：`__APP_VERSION__` 在测试里也要有值。
 *
 * 否则「侧边栏版本号」这类用例会因常量未定义而报 ReferenceError，或者被迫
 * 在测试里另造一个版本号 —— 那等于又开了一个真源，正好是本次要消灭的问题。
 */
const desktopPkg = JSON.parse(
  readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
) as { version?: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(desktopPkg.version ?? '0.0.0'),
  },
  test: {
    globals: true,
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    pool: 'forks',
    maxWorkers,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/main.tsx'],
    },
  },
});
