import { makeVitestConfig } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  test: {
    exclude: ['node_modules', 'dist'],
  },
});
