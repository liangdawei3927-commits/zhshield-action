import { defineConfig } from 'vitest/config';
import path from 'path';

const packagesDir = path.resolve(__dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      '@zh/shared': path.join(packagesDir, 'shared', 'src'),
      '@zh/kernel': path.join(packagesDir, 'kernel', 'src'),
      '@zh/guard': path.join(packagesDir, 'guard', 'src'),
      '@zh/inspect': path.join(packagesDir, 'inspect', 'src'),
      '@zh/pipeline': path.join(packagesDir, 'pipeline', 'src'),
    },
  },
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
});
