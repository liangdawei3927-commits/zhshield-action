import { makeVitestConfig, packagesDir } from '../shared/src/vitest.config.base';
import path from 'path';

export default makeVitestConfig({
  resolve: {
    alias: {
      // F5 集成测跨包引用 shared/kernel/sentinel：指向 src 保证被测代码始终是最新源码
      '@zh/shared': path.join(packagesDir, 'shared', 'src'),
      '@zh/kernel': path.join(packagesDir, 'kernel', 'src'),
      '@zh/sentinel': path.join(packagesDir, 'sentinel', 'src'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 30000,
  },
});
