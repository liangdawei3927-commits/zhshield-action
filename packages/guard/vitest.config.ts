import { makeVitestConfig } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  test: {
    environment: 'node',
  },
});
