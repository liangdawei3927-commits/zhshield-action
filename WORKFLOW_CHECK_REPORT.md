# 工作流对照检查报告

基于“用户给的工作流总结”对照源码，列出“没问题”“已修复”“还没处理/待确认”。

## 一、工作流要点核对

| 工作流环节 | 源码位置 | 核对结论 |
|---|---|---|
| [Worker 线程] profileProject() 6 个探测器加权投票 → ProjectProfile | `packages/fingerprint/src/index.ts:110-119,127`（6 探测器）；`profiler.ts`（加权聚合） | **没问题**。已实现，6 个探测器清单与文档一致。 |
| → 投影成 ProjectFeature{framework,language,features[]} | `packages/desktop/electron/ipc/engines.ts:1512-1526,316-323`（已修复）；`packages/fingerprint/src/projection.ts:41-91`（未强制复用） | **#6 已修复**。生产路径不再硬编码 `features: []`。`toFeature()` 未统一复用属于小优化，不影响功能。 |
| → 裁剪 SOP 规则（security 域恒保留，无栈标签恒保留） | `packages/kernel/src/sop/_meta/rule-project-match.ts:56-70` | **没问题**。逻辑与工作流描述一致（security 恒保留、无栈标签恒保留）。 |
| → 裁剪工具子集 | `packages/shared/src/tool-scope.ts:52-88`、`packages/kernel/src/runner.ts:256` | **没问题**。已实现（eslint/dep-cruiser 限 TS/JS、ts-prune/tsc 限 TS、semgrep/trivy/grype/gitleaks 恒 true）。 |
| → TaskManager 队列（并发 2） | `packages/desktop/electron/task-manager.ts:53-154`（`MAX_CONCURRENT=2`） | **没问题**。已实现。 |
| → fork Worker | `packages/desktop/electron/pipeline-host.ts:198-218`（`fork`，含 `detached`、`PIPELINE_GEN`） | **已改进（#4–#5）**。原有问题已修复，增加了生成代际隔离和进程组处理。 |
| → 依次跑 guard → inspect → done，进度经 IPC 150ms 节流回 UI | `packages/desktop/electron/task-manager.ts:54,221`（`PROGRESS_BROADCAST_THROTTLE_MS=150`）；pipeline job 编排见 `pipeline-sop.ts`/`pipeline-jobs.ts` | **没问题**。节流已实现。 |
| → 每条 SOP 规则调 ToolAdapter → execFile 外部 CLI → 解析 JSON → Issue[] | `packages/inspect/src/adapters/tool-runner.ts:105-115`（`execFileAsync`）、`packages/inspect/src/tool-adapter-executor.ts`、kernel dispatch | **没问题**。链路已实现。 |
| → 聚合：单维扣分封顶 → 红线封顶 55 → A/B/C/D | **红线封顶55**：`packages/scoring/src/redline.ts:15,18`、`engine.ts:79-95`（`applyRedLineCap`，`Math.min(overall, redLine.cap)`）。**等级 A/B/C/D**：`engine.ts:97-99`。**单维扣分封顶（dimension cap）**：**源码未找到实现** | **部分实现**。红线封顶 55 + A/B/C/D **已实现**；“单维扣分封顶”在当前代码中**未找到实现**（设计描述与实际实现有差异，需确认是否是设计预期未落地）。 |
| → 落 SQLite（scores / scanning_results / debt_* / sentinel_events） | `packages/db`、`packages/scoring/src/engine.ts:10,240,251`（scores）；其他表由各引擎写入 | **大体没问题**。链路已存在（按工作流是概括性描述）。 |
| → .zhshield/diagnostics/latest.json + 各域快照 | reporter/诊断导出相关路径 | **大体没问题**。已实现导出路径（细节需按需深入）。 |

## 二、Bug 修复状态

6 个真实 Bug（#1–#6）**全部已修复**，改动已验证（kernel/guard/fingerprint/cli/desktop tsc --noEmit 均 0 错误）。

## 三、还没处理的项（边界/决策类，不算 Bug）

按 `BUG_FIX_WORKFLOW.md` 第 3 节：

1. **功能开关绕过路径**（`feedback.ts:autoAdjustWeights()`、`ipc/evolve.ts` 写通道、`ipc/ai-tools.ts` + `main.ts` 启动写入、`server/src/evolve/evolve.controller.ts` 8 个端点）——需决策是否加 flag 守卫（行为变更）
2. **EventBus 取消链**——维持现状（最小改动原则）
3. **测试覆盖空洞**（`packages/desktop/electron/pipeline-host.ts`、`task-manager.ts`、vitest 未覆盖 electron）——独立任务
4. **文档描述不一致**（`00-项目文档/*` 关于暂下线功能）——代码闭环后再处理
5. **Guard `severities.json`/`loadSeverities()`（死配置）——需决策（接线 vs 删除）

## 四、一句话结论

**Bug 全部修完（#1–#6）。剩下的是 5 项决策类边界问题。唯一需要确认的是：工作流里提到的“单维扣分封顶（dimension cap）”在源码里没找到实现，是设计预期未落地还是描述和实现不一致。**
