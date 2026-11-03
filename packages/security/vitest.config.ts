import { makeVitestConfig, packagesSrcAlias } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  // @zh/shared 别名到 src：保证 mock('node:child_process') 能罩住 shared 内部的派发
  // （runToolOnce / probeToolVersion 都在 shared 里起进程）。理由见 packagesSrcAlias 的注释。
  resolve: { alias: packagesSrcAlias('shared') },
});
