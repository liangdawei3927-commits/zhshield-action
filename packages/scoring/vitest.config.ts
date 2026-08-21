import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  test: {
    server: {
      deps: {
        external: [/better-sqlite3/],
      },
    },
  },
});
