# Plan: zhiyan-codeshield 安全修复（P2）

## Objective
根据 `.omo/security-triage-report.md` 的分诊结果，落地修复 security-scan 检出的真实源码问题：
先修确定性高危项（命令注入 / shell:true / CORS / GCM / replace / ReDoS / 日志注入），
再引入共享安全路径助手消除路径穿越类，全程保持 `test` / `lint` / `build` / `guard` 绿灯。

## Constraints
- 不改 fixtures / 测试样本（eval / AWS Key / API Key 硬编码共 3 条在 fixtures 中，跳过）。
- 不执行 git commit。
- 行为保持：`safeJoin` / `safeResolve` 对合法输入返回与原 `path.join` / `path.resolve` 一致的结果，仅对越界输入抛错。
- 助手置于 `packages/shared/src/security/safe-path.ts`，经 `@zh/shared` 导出，各包以 `@zh/shared/security/safe-path` 引入。
- 每个改动配套针对性回归测试；复跑相关包 `test` / `lint` 须绿灯。

## TODOs
- [x] 1. 修复确定性高危项：命令注入×2、shell:true×1、CORS×1、GCM authTagLength×1、replace 非全局×1、ReDoS×5、日志注入×5（共 16 条真实源码），逐个带回归测试
- [x] 2. 新增共享安全路径助手 `packages/shared/src/security/safe-path.ts`（`safeJoin` / `safeResolve`，归一化 + 越界断言）+ 单元测试
- [x] 3. 在已依赖 @zh/shared 的包（kernel / sentinel / server）的路径穿越位点应用 `safeJoin` / `safeResolve`（依赖已就绪，低风险）
- [x] 4. 在其余包（dependency / security / performance / inspect / fingerprint / refactor / guard / db）的路径穿越位点应用 `safeJoin` / `safeResolve`（按需补充 @zh/shared workspace 依赖）
- [x] 5. 复跑 security-scan / guard，确认问题数下降且 test/lint/build 无回归

## Final Verification Wave
- [x] F1. `pnpm test` 全绿
- [x] F2. `pnpm lint` 全绿
- [x] F3. `pnpm build` 全绿（完整仓库 18/18 包编译通过；sentinel/auto-fixer.ts 的 execSync 导入缺失已按用户要求一并修复）
- [x] F4. `guard --dry-run` security-scan 0 失败（门禁通过）
