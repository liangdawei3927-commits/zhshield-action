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
    // 只校验源码内模块边界：构建产物（dist/build/coverage）非人工编辑，
    // 其内部相互引用会稳定产生 no-circular 误报（见 F5 契约：校验 src/ 目录）。
    // e2e/fixtures 为刻意构造的循环依赖样本（验证引擎检出能力），排除其避免
    // 仓库级全量扫描误报；adapter 扫描 fixture 自身时扫描根为 fixture 目录，
    // 路径不含 e2e/fixtures 段，不受影响。
    exclude: {
      path: '(^|/)(node_modules|dist|dist-electron|build|coverage|e2e/fixtures)(/|$)',
    },
  },
};
