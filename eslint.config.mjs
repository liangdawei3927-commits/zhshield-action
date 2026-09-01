import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import noFsSync from './eslint-rules/no-fs-sync.mjs';
import perfNoSerialAwait from './eslint-rules/perf-no-serial-await.mjs';
import perfNoSyncFsHotpath from './eslint-rules/perf-no-sync-fs-hotpath.mjs';
import perfWalkRequiresIgnore from './eslint-rules/perf-walk-requires-ignore.mjs';
import perfBatchDbWrite from './eslint-rules/perf-batch-db-write.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/coverage/**',
      '**/release/**',
      '**/.turbo/**',
      '**/build/**',
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'packages/**/*.{ts,tsx,mjs,js,cjs}',
      'scripts/**/*.{mjs,cjs,js}',
      'eslint-rules/**/*.{mjs,js,cjs}',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 全仓源码/测试已清零真实 any，编译产物已 gitignore → 升为 error 硬性门禁
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-case-declarations': 'warn',
    },
  },
  {
    files: ['packages/desktop/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  // AutoPerf P2 perf-* 规则集（底座 B）：用自己的引擎扫自己的代码，每次门禁自动体检。
  // 4 条规则分别对应已修复的真实瓶颈：P0-1 串行 await、P1-7 async 内同步 fs、
  // P0-5 遍历不忽略 node_modules、P1-6 循环内单行 db 写入。
  // 作用域：仅生产代码。测试/脚本中的 sync fs、串行 await 属测试惯用法/一次性工具，
  // 非热路径，不适用（曾误报 270 处测试违规）。
  {
    files: ['packages/**/*.{ts,tsx,mjs,js,cjs}'],
    ignores: [
      'packages/**/__tests__/**',
      'packages/**/*.test.{ts,tsx,mjs,js,cjs}',
      'packages/**/*.spec.{ts,tsx,mjs,js,cjs}',
      'packages/**/e2e/**',
      'packages/**/scripts/**',
    ],
    plugins: {
      perf: {
        rules: {
          'perf-no-serial-await': perfNoSerialAwait,
          'perf-no-sync-fs-hotpath': perfNoSyncFsHotpath,
          'perf-walk-requires-ignore': perfWalkRequiresIgnore,
          'perf-batch-db-write': perfBatchDbWrite,
        },
      },
    },
    rules: {
      'perf/perf-no-serial-await': 'error',
      'perf/perf-no-sync-fs-hotpath': 'error',
      'perf/perf-walk-requires-ignore': 'error',
      'perf/perf-batch-db-write': 'error',
    },
  },
  // 主进程禁止 fs 同步 IO（P1-7 性能门禁）：CI 强制“主进程 0 处 sync IO”
  {
    files: ['packages/desktop/electron/**/*.ts'],
    plugins: {
      'no-fs-sync': { rules: { 'no-fs-sync': noFsSync } },
    },
    rules: {
      'no-fs-sync/no-fs-sync': 'error',
    },
  },
  // profile-worker.ts 运行在独立 worker 线程（非主进程），阻塞 IO 合法且有意为之，故豁免
  {
    files: ['packages/desktop/electron/profile-worker.ts'],
    rules: {
      'no-fs-sync/no-fs-sync': 'off',
    },
  },
);
