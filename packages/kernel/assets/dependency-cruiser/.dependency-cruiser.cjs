/**
 * 智汇码盾 — dependency-cruiser 默认校验配置
 *
 * 由 SOP 规则 inspect.scan.official.circular-dependency 注入（--validate），
 * 无需被扫描项目自带 .dependency-cruiser.cjs。
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
