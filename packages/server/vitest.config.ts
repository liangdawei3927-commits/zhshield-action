import { makeVitestConfig } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  test: {
    environment: 'node',
    testTimeout: 60000,
    coverage: {
      exclude: ['src/main.ts'],
    },
  },
});
