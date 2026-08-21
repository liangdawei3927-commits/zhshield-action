import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  aliases: {
    '@zh/shared': 'shared',
    '@zh/kernel': 'kernel',
    '@zh/guard': 'guard',
    '@zh/inspect': 'inspect',
    '@zh/refactor': 'refactor',
  },
  test: {
    testTimeout: 300000,
    pool: 'forks',
  },
});
