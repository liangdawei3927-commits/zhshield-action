import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  test: { environment: 'node' },
});
