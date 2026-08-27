# Plan: zhiyan-codeshield 安全扫描分诊（149 条 security-scan）

## Objective
对 Guard 的 `security-scan` 检出的 149 条结果做分诊：按类别归类、区分真实源码 vs fixtures/测试、给出可落地的具体修复建议。本阶段**只分析与产出报告，不改源码**。

## Constraints
- 仅分析与报告，不改任何源码文件。
- 不执行 git commit。
- 数据源：`/tmp/dump2.log` 中 GuardReport 的 `guard.block.external.security-scan` 违规列表（约 149 条）。

## TODOs
- [x] 1. 从 `/tmp/dump2.log` 提取 149 条 security-scan 违规，按类别（路径穿越 / ReDoS / 日志注入 等）归类并统计数量
- [x] 2. 区分真实源码文件（`packages/*/src`）与 fixtures / `__tests__` / 脚本，标记误报与低风险项
- [x] 3. 针对每类给出具体修复建议（输入校验归一化、正则硬编码、常量日志模板），输出分诊报告

## Final Verification Wave
- [x] F1. 分诊报告覆盖全部 149 条（总数对账一致）
- [x] F2. 每类至少 1 个真实源码示例 + 对应修复建议（含代码示例）
- [x] F3. 报告写入 `.omo/security-triage-report.md`
