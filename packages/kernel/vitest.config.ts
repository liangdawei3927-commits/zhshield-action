import { createPackageVitestConfig } from '../../vitest.shared';

export default createPackageVitestConfig({
  aliases: {
    '../../sentinel/src': 'sentinel',
    '../../scoring/src': 'scoring',
    '../../evolve/src': 'evolve',
    '../../inspect/src': 'inspect',
  },
});
