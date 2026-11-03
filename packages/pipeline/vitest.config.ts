import { makeVitestConfig, packagesSrcAlias } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  resolve: {
    alias: packagesSrcAlias(
      'shared',
      'kernel',
      'guard',
      'inspect',
      'refactor',
      'fingerprint',
      'garbage',
      'performance',
      'dependency',
      'security',
    ),
  },
  test: {
    testTimeout: 300000,
    pool: 'forks',
  },
});
