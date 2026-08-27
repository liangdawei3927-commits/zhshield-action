import { makeVitestConfig, packagesDir } from '../shared/src/vitest.config.base';
import path from 'path';

export default makeVitestConfig({
  resolve: {
    alias: {
      '@zh/shared': path.join(packagesDir, 'shared', 'src'),
      '@zh/kernel': path.join(packagesDir, 'kernel', 'src'),
      '@zh/guard': path.join(packagesDir, 'guard', 'src'),
      '@zh/inspect': path.join(packagesDir, 'inspect', 'src'),
      '@zh/refactor': path.join(packagesDir, 'refactor', 'src'),
    },
  },
  test: {
    testTimeout: 300000,
    pool: 'forks',
  },
});
