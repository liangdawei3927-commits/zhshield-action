# Plan: zhiyan-codeshield 体检修复（低风险门禁解堵 + 质量债清理）

## Objective
解堵 Guard 门禁、清理体检报告里的低风险代码质量债，且不改变任何运行时行为。所有改动必须保持 `pnpm test` / `pnpm lint` / `pnpm build` 以及 guard/inspect CLI 全绿。

## Constraints
- 不执行 git commit。
- 不使用 `as any` / `@ts-ignore` / 非空断言 `!`。
- 除既定的 lint/配置修复外，禁止改变运行时行为。

## TODOs
- [x] 1. 将 fixtures 目录排除出 eslint-error(guard) 与 eslint-rules(inspect) 扫描，解堵门禁
- [x] 2. eslint-performance 10 处经核实为误报（均为 Set→数组必需展开，且仓库启用的 eslint 未启用该规则），无需改动；lint/test 全绿
- [x] 3. 抽取共享 vitest 配置基座，重构 4 个 vitest.config.ts 复用（重复代码异味 75→6）

## Final Verification Wave
- [x] F1. guard CLI：`eslint-error` 检查转为 passed（门禁不再因该 fixture 误报阻断）
- [x] F2. `pnpm test` 全绿（35/35）
- [x] F3. `pnpm lint` 全绿（19/19）
- [x] F4. `pnpm build` 全绿（18/18）
