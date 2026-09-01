/**
 * 智汇码盾 — ESLint 性能检测配置（flat config）
 *
 * 被 SOP 规则 inspect.scan.performance.eslint 通过
 * `check.toolConfig.config` 引用，经 ESLintAdapter 以
 * `--no-eslintrc --config <本文件>` 注入扫描。
 *
 * 插件（均为 @zh/kernel 的 dependencies，可从本文件位置解析）：
 * - @eslint-performance/plugin-runtime-complexity — 运行时复杂度反模式
 * - @e18e/eslint-plugin — 现代化 + 性能改进规则
 * - @typescript-eslint/parser — TS 源码解析
 *
 * 覆盖 JS/JSX/MJS/CJS 与 TS/TSX 源码；忽略 dist 等 build 产物。
 */
import runtimeComplexity from '@eslint-performance/plugin-runtime-complexity';
import e18e from '@e18e/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import perfNoSerialAwait from './perf-no-serial-await.mjs';
import perfNoSyncFsHotpath from './perf-no-sync-fs-hotpath.mjs';
import perfWalkRequiresIgnore from './perf-walk-requires-ignore.mjs';
import perfBatchDbWrite from './perf-batch-db-write.mjs';

const performanceRules = {
  // ── @eslint-performance/plugin-runtime-complexity ──
  'runtime-complexity/no-immutable-reduce': 'warn',
  'runtime-complexity/no-unnecessary-array-spread': 'warn',
  'runtime-complexity/no-quadratic-loop-operations': 'warn',

  // ── @e18e/eslint-plugin — modernization ──
  'e18e/prefer-array-at': 'warn',
  'e18e/prefer-array-fill': 'warn',
  'e18e/prefer-includes': 'warn',
  'e18e/prefer-array-to-reversed': 'warn',
  'e18e/prefer-array-to-sorted': 'warn',
  'e18e/prefer-array-to-spliced': 'warn',
  'e18e/prefer-nullish-coalescing': 'warn',
  'e18e/prefer-object-has-own': 'warn',
  'e18e/prefer-spread-syntax': 'warn',
  'e18e/prefer-url-canparse': 'warn',

  // ── @e18e/eslint-plugin — performance improvements ──
  'e18e/prefer-array-from-map': 'warn',
  'e18e/prefer-timer-args': 'warn',
  'e18e/prefer-date-now': 'warn',
  'e18e/prefer-regex-test': 'warn',
  'e18e/prefer-array-some': 'warn',
  'e18e/prefer-static-regex': 'warn',
  'e18e/prefer-string-fromcharcode': 'warn',

  // ── 自研 perf-* 规则（AutoPerf P2，Dogfooding → 官方规则库）──
  'perf/perf-no-serial-await': 'warn',
  'perf/perf-no-sync-fs-hotpath': 'warn',
  'perf/perf-walk-requires-ignore': 'warn',
  'perf/perf-batch-db-write': 'warn',
};

const performancePlugins = {
  'runtime-complexity': runtimeComplexity,
  e18e,
  perf: {
    rules: {
      'perf-no-serial-await': perfNoSerialAwait,
      'perf-no-sync-fs-hotpath': perfNoSyncFsHotpath,
      'perf-walk-requires-ignore': perfWalkRequiresIgnore,
      'perf-batch-db-write': perfBatchDbWrite,
    },
  },
};

export default [
  // 全局忽略：build 产物与依赖
  {
    ignores: ['**/dist/**', '**/dist-electron/**', '**/node_modules/**'],
  },
  // JS/JSX/MJS/CJS 源码
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    plugins: performancePlugins,
    rules: performanceRules,
  },
  // TS/TSX 源码（使用 @typescript-eslint/parser）
  {
    files: ['**/*.{ts,tsx}'],
    plugins: performancePlugins,
    languageOptions: {
      parser: tsParser,
    },
    rules: performanceRules,
  },
];
