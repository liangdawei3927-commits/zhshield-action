import { defineConfig } from 'vitest/config';
import type { UserConfig } from 'vitest/config';
import path from 'path';
import { detectMachineProfile } from './packages/shared/src/machine-profile';

const DEFAULT_TEST_INCLUDE = 'src/__tests__/**/*.test.ts';
const DEFAULT_COVERAGE_INCLUDE = ['src/**/*.ts'];
const DEFAULT_COVERAGE_EXCLUDE = ['src/__tests__/**', 'src/types.ts', 'src/index.ts'];
const DEFAULT_COVERAGE_THRESHOLDS = { statements: 70, branches: 60, functions: 70, lines: 70 };

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

const envRaw = process.env.ZH_VITEST_MAX_WORKERS;
const envMax = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
const maxWorkers = Number.isFinite(envMax)
  ? clamp(envMax, 1, 4)
  : detectMachineProfile().vitestMaxWorkers;

export interface CreateVitestConfigOptions {
  /** Monorepo `packages` 目录，alias 目标基于它解析。 */
  packagesDir: string;
  /** resolve.alias 条目：alias -> packages 下的包名（自动追加 src 目录）。 */
  aliases?: Record<string, string>;
  /** 合并到默认 test 配置的额外选项（如 environment、testTimeout、pool）。 */
  test?: UserConfig['test'];
  /** 测试文件 glob，默认 'src/__tests__/**\/*.test.ts'。 */
  include?: string;
  /** coverage 覆盖项，缺省使用公共默认值。 */
  coverage?: {
    include?: string[];
    exclude?: string[];
    /** 传 false 表示完全禁用 thresholds。 */
    thresholds?: Record<string, number> | false;
  };
}

export function createVitestConfig(options: CreateVitestConfigOptions) {
  const { packagesDir, aliases = {}, test, include, coverage } = options;

  const alias = Object.fromEntries(
    Object.entries(aliases).map(([find, target]) => [find, path.join(packagesDir, target, 'src')]),
  );

  return defineConfig({
    ...(Object.keys(alias).length > 0 ? { resolve: { alias } } : {}),
    test: {
      globals: true,
      include: [include ?? DEFAULT_TEST_INCLUDE],
      pool: 'forks',
      maxWorkers,
      ...test,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov', 'json-summary'],
        include: coverage?.include ?? DEFAULT_COVERAGE_INCLUDE,
        exclude: coverage?.exclude ?? DEFAULT_COVERAGE_EXCLUDE,
        ...(coverage?.thresholds === false
          ? {}
          : { thresholds: coverage?.thresholds ?? DEFAULT_COVERAGE_THRESHOLDS }),
      },
    },
  });
}

export function createPackageVitestConfig(options: Omit<CreateVitestConfigOptions, 'packagesDir'>) {
  return createVitestConfig({
    packagesDir: path.join(__dirname, 'packages'),
    ...options,
  });
}
