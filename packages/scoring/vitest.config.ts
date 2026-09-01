import { makeVitestConfig } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  test: {
    server: {
      deps: {
        external: [/better-sqlite3/],
      },
    },
  },
});
