import { makeVitestConfig, packagesSrcAlias } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  // F5 集成测跨包引用 shared/kernel/sentinel：指向 src 保证被测代码始终是最新源码，
  // 且 mock('node:child_process') 能罩住 @zh/shared 内部的派发（见 packagesSrcAlias 注释）。
  resolve: { alias: packagesSrcAlias('shared', 'kernel', 'sentinel') },
  test: {
    environment: 'node',
    testTimeout: 30000,
  },
});
