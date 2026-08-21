import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  include: 'src/__tests__/**/*.{test,spec}.{ts,tsx}',
  test: { environment: 'node' },
  coverage: {
    include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    exclude: ['src/__tests__/**', 'src/main.tsx'],
    thresholds: { statements: 60, branches: 50, functions: 60, lines: 60 },
  },
});
