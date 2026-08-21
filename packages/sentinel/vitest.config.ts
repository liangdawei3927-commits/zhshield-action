import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  test: { environment: 'node', testTimeout: 10000 },
});
