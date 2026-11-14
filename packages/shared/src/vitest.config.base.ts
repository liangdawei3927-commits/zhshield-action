import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import path from 'path';
import { resolveVitestMaxWorkers } from './machine-profile';

/** Absolute path to the monorepo `packages/` directory. */
export const packagesDir = path.resolve(__dirname, '..', '..');

/**
 * 构造 `@zh/<pkg>` → `packages/<pkg>/src` 的别名表（供各包 vitest.config.ts 一起用）。
 *
 * 为什么不各写各的：
 *   ① 被测代码取最新源码，而不是 `node_modules` 里的 dist；
 *   ② 用例对 `node:child_process` 的 `vi.mock` 才罩得住 `@zh/shared` **内部**的派发
 *      （`runToolOnce` / `probeToolVersion` 都在 shared 里起进程）。不别名时
 *      `@zh/shared` 从 dist 外部化加载，mock 静默失效 —— 2026-11-03 实测
 *      security 19 条、guard 1 条用例因此假红（"期望没调外部工具"其实没进 mock）。
 */
export function packagesSrcAlias(...names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [`@zh/${name}`, path.join(packagesDir, name, 'src')]),
  );
}

/** vitest 最大 worker 数：实现已下沉到 machine-profile（不依赖 vitest），此处转出保持既有导入路径。 */
export { resolveVitestMaxWorkers };

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
