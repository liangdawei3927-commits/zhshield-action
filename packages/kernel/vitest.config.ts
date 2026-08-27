import { makeVitestConfig, packagesDir } from '../shared/src/vitest.config.base';
import path from 'path';

export default makeVitestConfig({
  resolve: {
    alias: {
      '../../sentinel/src': path.join(packagesDir, 'sentinel', 'src'),
      '../../scoring/src': path.join(packagesDir, 'scoring', 'src'),
      '../../evolve/src': path.join(packagesDir, 'evolve', 'src'),
      '../../inspect/src': path.join(packagesDir, 'inspect', 'src'),
    },
  },
});
