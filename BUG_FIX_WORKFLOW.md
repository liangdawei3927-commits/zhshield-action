# zhihui-codeshield Bug 修复工作流

> 本文档记录「上次诊断报告里发现的 6 个真实 Bug」的修复状态，用于跟踪“哪些修复了、哪些还没修复”。所有结论基于静态源码调查 + 最小改动原则。

## 修复原则

- 代码优先，文档后改。先封代码（行为变更需谨慎），再更新文档。
- 最小改动（minimal diff），不改动无关逻辑，不随意重构。
- 遵守 AGENTS.md：测试与 typecheck 严禁并行；单包改动优先用 `pnpm --filter @zh/<pkg> exec tsc --noEmit`；desktop E2E 本机不可跑；无新依赖。
- 以代码为准，文档与实现不一致时优先以代码行为为事实。

---

## 1. 核心问题清单（6 个真实 Bug）

| Bug 编号 | 标题                                            | 根因（关键点）                                                                                                                                                                                                                                                  | 影响                                                                                                                                       | 修复优先级         |
| ------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| #1     | 工具不可用（unavailable）未标记 degraded，导致假绿           | `packages/kernel/src/runner/dispatch-evaluators.ts:430-455`：`result.status === 'unavailable'` 映射为 `skipped`，但返回对象未设置 `degraded`                                                                                                                          | kernel 聚合器按 `degraded===0` 判断 `ok`，导致“什么都没实际检查”（工具不可用）仍可能被判定通过                                                                           | P0            |
| #2     | Guard/CLI 降级信号未透传，假绿未能阻断                      | `packages/guard/src/engine.ts:264-276` 的 `evalToCheckResult` 未透传 `ev.degraded`；`packages/cli/src/degraded.ts:39-43` 仅对 GuardReport 零结果（total===0）计降级，未统计 `results[].degraded===true`                                                                     | 即使 kernel 已产出 degraded，默认 guard 路径的 exit 判定仍可能漏掉降级信号                                                                                     | P0（与 #1 同因果链） |
| #3     | pnpm/Turborepo monorepo 被误判为 monolith         | `packages/fingerprint/src/profiler-target.ts:62-80` 只认 `manifest:workspace`（根 `package.json` 的 `workspaces` 字段）。本仓库用 `pnpm-workspace.yaml` + `turbo.json`，根 package.json 无 workspaces，且 `config:workspace` 信号已被 `config-detector.ts` 产出但未被读取             | 项目架构识别错误（`modular-monolith` vs `monolith`），导致画像语义漂移、规则裁剪/工具裁剪路径不一致（A/B/C 三套 Profile 分歧被放大）                                               | P0/P1         |
| #4–#5  | 编排取消/超时：取消不杀子进程、超时 SIGTERM 误伤兄弟任务             | `packages/desktop/electron/task-manager.ts:127-147` 取消 `running` 任务只改状态、不触碰进程；`pipeline-protocol.ts:95-103` 无 `cancel` 消息；`pipeline-host.ts:216-226` 超时直接 `child.kill('SIGTERM')`（整 worker），单 worker 承载 ≤2 并发 job；`fork()` 未设置 `detached:true`，孙进程难以按组清理 | 任务取消失效（IPC 挂起等待超时）、单个 job 超时会杀死承载所有兄弟 job 的共享 worker（误伤兄弟任务、错误信息被掩盖为 worker 崩溃）、跨代退出污染、孙进程（外部工具如 eslint/semgrep）可能孤儿                     | P0            |
| #6     | 桌面端投影硬编码 `features: []`，丢弃 fingerprint/评分画像特征 | `packages/desktop/electron/ipc/engines.ts:1509-1511`（A 路径）、`:317-319`（B 路径）将 `features` 硬编码为空数组。`packages/fingerprint/src/projection.ts` 存在 `toFeature`（零生产调用方）但生产路径未复用                                                                                  | A 路径探测到的 productForm/architecture/environments、B 路径的 type/runtime/isMonorepo 等特征全部被丢弃，影响规则匹配（`rule-project-match`/`STACK_TAGS`）与工具裁剪的一致性 | P1            |

> 备注：功能开关（`FEATURE_EVOLVE_ENABLED=false`、`FEATURE_AI_TOOL_ENABLED=false`）相关的程序化可达路径（feedback.autoAdjustWeights、evolve/ai-tools IPC、server evolve controller、演进域 active SOP 规则仍可能加载）在本次最小修复范围内**未处理**，属于“行为变更需决策”的边界问题，不计入上方 6 个 bug。

---

## 2. 修复状态

| Bug   | 状态    | 修复文件                                                                                                       | 关键改动                                                                                                                                                                                                                                                                                                 | 验证                                                        |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| #1    | ✅ 已修复 | `packages/kernel/src/runner/dispatch-evaluators.ts:453`                                                    | `unavailable` 映射为 `skipped` 时，补充 `...(result.status === 'unavailable' ? { degraded: true as const } : {})`                                                                                                                                                                                           | `@zh/kernel` tsc --noEmit 0 错误                            |
| #2    | ✅ 已修复 | `packages/guard/src/engine.ts:275`、`packages/cli/src/degraded.ts:41-44`                                    | Guard 将 `ev.degraded` 透传到 `CheckResult`（仅 true 时）；CLI 的 `countDegraded` 在 GuardReport `results[]` 中也统计 `degraded===true`，优先返回该计数                                                                                                                                                                     | `@zh/guard`、`@zh/cli`（`zhshield-cli` 包名）tsc --noEmit 0 错误 |
| #3    | ✅ 已修复 | `packages/fingerprint/src/profiler-target.ts:65-74`                                                        | `determineArchitecture` 同时识别 `manifest:workspace` 与 `config:workspace`（pnpm-workspace.yaml/turbo.json），使用 `workspaceSignals` 合并返回信号                                                                                                                                                                  | `@zh/fingerprint` tsc --noEmit 0 错误                       |
| #4–#5 | ✅ 已修复 | `packages/desktop/electron/pipeline-protocol.ts`、`pipeline-worker.ts`、`pipeline-host.ts`、`task-manager.ts` | 协议新增 `PipelineCancelMsg`；worker 为每个任务创建 `AbortController` 并处理 `cancel`；host 增加 `workerGen/workerPid`、`fork` `detached` + `PIPELINE_GEN`、超时先 `cancel`（2.5s 宽限）再按 `process.kill(-pid, 'SIGTERM')` 进程组强制终止并忽略跨代 exit、导出 `cancelJob(id)`；task-manager 取消 running 任务时调用 `cancelJob(task.id)`（best-effort） | `desktop` tsc --noEmit 0 错误（npm notice 忽略）                |
| #6    | ✅ 已修复 | `packages/desktop/electron/ipc/engines.ts:1512-1526, 316-323`                                              | A 路径（fingerprint）：从 `target.productForm/architecture/environments[]` 构建 `features[]`；B 路径（scoring）：从 `profile.type/runtime/isMonorepo` 构建 `features[]`（isMonorepo → `modular-monolith`）                                                                                                              | `desktop` tsc --noEmit 0 错误                               |

---

## 3. 未修复项（边界/决策类，不属于 6 个 Bug）

| 项目                                         | 位置                                                                                                                                                                                                                 | 说明                                                                                                   | 是否必须修复        | 建议处理方式                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| 功能开关绕过路径                                   | `packages/desktop/electron/ipc/feedback.ts:74-91`（`autoAdjustWeights()`）、`ipc/evolve.ts`（5 个 handler 含写通道）、`ipc/ai-tools.ts` + `main.ts:314,429`（启动写项目文件）、`packages/server/src/evolve/evolve.controller.ts`（8 个端点） | `FEATURE_EVOLVE_ENABLED=false`、`FEATURE_AI_TOOL_ENABLED=false` 仅 UI/少量路由封死，程序化路径仍可达。报告建议“先封代码，再改文档”。 | 非强制 Bug（行为变更） | 需用户决策：是否要为这些路径加 flag 守卫（会改变现有行为）。建议单独 PR 处理，不放入最小 bug 修复。 |
| EventBus 取消链                               | 整体编排（`task-manager/pipeline-host/worker`）                                                                                                                                                                          | AGENTS.md 声明“横向通信走 EventBus”，但取消/超时链未走 EventBus（当前靠 pending map + IPC）。报告标注为“未找到实现”，不视为缺陷。           | 否             | 保持现状（最小改动原则）。如要统一架构，可后续重构，不影响 bug 修复效果。                   |
| 测试覆盖空洞                                     | `packages/desktop/electron/pipeline-host.ts`、`task-manager.ts`、`vitest.config.ts`（未覆盖 `electron/`）                                                                                                                 | 没有行为测试覆盖这两个关键编排模块，是导致缺陷长期未发现的原因，但不是修复缺陷本身。                                                           | 建议补充          | 独立任务（测试补全），不在本轮最小修复范围内。                                   |
| 文档描述不一致                                    | `00-项目文档/*`（evolve/AI 工具可用性描述）                                                                                                                                                                                     | 文档中部分章节仍将暂下线功能描述为可用/已开启。按原则先封代码，再改文档。当前代码已按最小改动修复行为相关部分，文档修订待代码闭环后再做。                                | 否             | 代码修复完成后再统一修订文档，避免把仍可能活跃的路径提前抹除。                           |
| Guard `severities.json`/`loadSeverities()` | `packages/guard/config/severities.json`、`config-loader.ts:17-21`                                                                                                                                                   | 生产代码中 `loadSeverities()` 未被调用（仅测试用），属于“死配置”。是否清理需决策（接线 vs 删除），语义互斥。                                  | 否             | 不处理，避免破坏测试预期或未来接线方式。                                      |

---

## 4. 改动概要

- **修改文件数**：9
- **变更行数**：+155 / -25（共 180 行变更）
- **涉及包**：`@zh/kernel`、`@zh/guard`、`@zh/cli`（`zhshield-cli`）、`@zh/fingerprint`、`desktop/electron`
- **类型检查**：全部相关包 `tsc --noEmit` 通过（kernel/guard/fingerprint/cli/desktop 均 0 错误）

---

## 5. 使用方式

每次需要确认修复进度时，直接查看本文件的 **第 2 节「修复状态」**：

- ✅ = 已修复（代码已改、类型检查通过）
- 空/未列出 = 尚未处理（按上方清单区分 Bug vs 边界项）

如需继续处理剩余未修复项，建议按“Bug 修复（最小改动）→ 行为闭环（flag 守卫，可选决策）→ 测试补全 → 文档修订”的顺序推进，避免将决策类变更混入 bug 修复提交。
