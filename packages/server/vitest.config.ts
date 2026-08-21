import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  test: { environment: 'node', testTimeout: 60000 },
  coverage: {
    exclude: ['src/__tests__/**', 'src/types.ts', 'src/index.ts', 'src/main.ts'],
  },
});
