import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  aliases: {
    '@zh/shared': 'shared',
  },
  test: {
    environment: 'node',
    testTimeout: 60000,
  },
});
