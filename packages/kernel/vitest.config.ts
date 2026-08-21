import { defineConfig } from 'vitest/config';
import path from 'path';

const packagesDir = path.resolve(__dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      '../../sentinel/src': path.join(packagesDir, 'sentinel', 'src'),
      '../../scoring/src': path.join(packagesDir, 'scoring', 'src'),
      '../../evolve/src': path.join(packagesDir, 'evolve', 'src'),
      '../../inspect/src': path.join(packagesDir, 'inspect', 'src'),
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
