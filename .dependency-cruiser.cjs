/**
 * 智汇码盾 — dependency-cruiser 校验配置（自举扫描用）
 *
 * inspect.scan.depcruiser.circular-dependency 规则注入 configFile:
 * ".dependency-cruiser.cjs"，适配器无注入配置时按项目本地回退解析该文件。
 * 内容与 kernel 内置资产 packages/kernel/dist/assets/dependency-cruiser/ 一致。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '禁止循环依赖：模块间不应存在循环引用',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: './tsconfig.json' },
    exclude: {
      path: '^node_modules',
    },
  },
};