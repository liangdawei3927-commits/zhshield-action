import { defineConfig } from 'vitest/config';
import path from 'path';

const packagesDir = path.resolve(__dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      // F5 集成测跨包引用 shared/kernel/sentinel：指向 src 保证被测代码始终是最新源码
      '@zh/shared': path.join(packagesDir, 'shared', 'src'),
      '@zh/kernel': path.join(packagesDir, 'kernel', 'src'),
      '@zh/sentinel': path.join(packagesDir, 'sentinel', 'src'),
    },
  },
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
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
