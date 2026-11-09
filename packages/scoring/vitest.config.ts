import { makeVitestConfig, packagesSrcAlias } from '../shared/src/vitest.config.base';

export default makeVitestConfig({
  resolve: {
    // R5 新增的 isReferenceDimension 等符号必须从 shared **源码**解析：
    // pnpm 的注入副本 / dist 不会随 src 新增自动更新，否则测试报
    // `isReferenceDimension is not a function`（看起来像代码缺陷）。
    alias: packagesSrcAlias('shared'),
  },
  test: {
    server: {
      deps: {
        external: [/better-sqlite3/],
      },
    },
  },
});
