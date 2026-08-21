import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  test: { exclude: ['node_modules', 'dist'] },
});
