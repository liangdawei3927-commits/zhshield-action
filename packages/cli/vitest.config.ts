import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  aliases: {
    '@zh/shared': 'shared',
    '@zh/kernel': 'kernel',
    '@zh/guard': 'guard',
    '@zh/inspect': 'inspect',
    '@zh/pipeline': 'pipeline',
    '@zh/reporter': 'reporter',
  },
});
