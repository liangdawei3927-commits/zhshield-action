# Triage: duplicated-code 100 条分诊（2026-09-30）

## 背景
zhcheck 基线 100 条 duplicated-code warning（本轮检测器修复未影响该规则，仍为 100）。
去重后为 **37 对** 文件间重复。本文档按「IPC 镜像对 / 真实重复 / 巧合相似」三分类落盘，
供后续决定是否修复、如何修复。

扫描口径：`node scripts/zhcheck.mjs --refactor`（minDuplicateLines=5，按归一化块匹配）。

## 分类总览
| 分类 | 对数 | 条数(约) | 处置建议 |
|---|---|---|---|
| A. IPC 渲染器↔主进程镜像对 | 13 | ~34 | 结构豁免为主，部分可抽 shared |
| B. 真实重复（可提取公共代码） | 17 | ~54 | 择机提取，区分 quick win |
| C. 巧合相似 / e2e 脚手架 | 4 | ~12 | 保留不动（测试并行结构） |

## A. IPC 渲染器↔主进程镜像对（架构性镜像）
Electron 主进程 `ipc/*.ts` handler 与渲染进程 `preload.ts` / `services/engineApi.ts` API 表面
必须各存一份同名同构代码（进程边界无法共享运行时模块），此类重复是架构强制的镜像，非可消除债务。

| 重复对 | 条数 | 样例证据 |
|---|---|---|
| `electron/ipc/engines.ts` ↔ `services/engineApi.ts` | 8 | 空默认返回对象 `{ summary:{...0}, checks:[], metadata:{...} }` 镜像 |
| `electron/ipc/feedback.ts` ↔ `services/engineApi.ts` | 4 | `FalsePositiveFeedbackItem` 接口双份声明 |
| `electron/ipc/guard-config.ts` ↔ `services/engineApi.ts` | 2 | 镜像 handler |
| `electron/ipc/scheduler.ts` ↔ `services/engineApi.ts` | 2 | 镜像 handler |
| `electron/preload.ts` ↔ `services/engineApi.ts` | 2 | 镜像桥 |
| `electron/ipc/feedback.ts` ↔ `electron/preload.ts` | 2 | 镜像 |
| `electron/task-manager.ts` ↔ `electron/preload.ts` | 2 | 镜像 |
| `electron/ipc/backup.ts` ↔ `scoring/src/types.ts` | 2 | IPC 侧镜像 scoring 类型 |
| `electron/ipc/scheduler.ts` ↔ `kernel/scheduler/types.ts` | 2 | 镜像 kernel 类型 |
| `electron/ipc/deps-baseline.ts` ↔ `shared/src/baseline.ts` | 4 | **shared 已存在，应改 import 而非镜像** |
| `electron/ipc/report-format.ts` ↔ `performance/src/types.ts` | 2 | 镜像类型 |
| `electron/pipeline-report.ts` ↔ `performance/src/types.ts` | 2 | 镜像类型 |
| `electron/ipc/e2e-observation.ts` ↔ `db/src/queries.ts` | 2 | 镜像查询参数形状 |

处置：A 类默认豁免（结构镜像）。例外 `deps-baseline ↔ shared/baseline`：shared 包已存在，
此对可转为跨包 import（低风险 quick win，需核 shared 包导出面）。

## B. 真实重复（可提取公共代码）
同一包内或跨包复制粘贴，行为相同、可参数化提取。

### B1. 同包内重复（最易治理）
| 重复对 | 条数 | 样例证据 |
|---|---|---|
| `db/src/batch.ts` ↔ `db/src/queries.ts` | 2 | 同一段 `INSERT INTO debt_actions ... ON CONFLICT DO UPDATE` SQL 常量 |
| `dependency/adapters/env-consistency.ts` ↔ `dependency/src/lockfile-utils.ts` | 4 | `NEWLINE_RE` / `INDENT_RE` 正则常量双份 |
| `dependency/adapters/typosquat-detector.ts` ↔ `dependency/adapters/upgrade-evaluator.ts` | 2 | `escapeRegExp()` 逐字相同 |
| `dependency/adapters/lockfile-verifier.ts` ↔ `dependency/src/graph-builder.ts` | 4 | 锁文件解析逻辑重复 |
| `electron/ipc/resolve-reconcile.ts` ↔ `electron/orphan-reconcile.ts` | 4 | 同名 reconcile 逻辑 |
| `electron/pipeline-host.ts` ↔ `electron/profile-host.ts` | 2 | host 生命周期脚手架 |
| `electron/ipc/report-format.ts` ↔ `electron/pipeline-report.ts` | 2 | 报告格式化 |
| `electron/ipc/report-format.ts` ↔ `electron/zh-diagnostics.ts` | 2 | 报告格式化 |
| `electron/pipeline-report.ts` ↔ `electron/zh-diagnostics.ts` | 2 | 报告格式化 |

### B2. 跨包重复（需抽包/抽公共模块）
| 重复对 | 条数 | 样例证据 |
|---|---|---|
| `pipeline/src/project-profile.ts` ↔ `dependency/adapters/env-consistency.ts` | 4 | `ProjectLanguage` / `PackageManager` 类型联合双份 |
| `fingerprint/src/profile-store.ts` ↔ `electron/orphan-reconcile.ts` | 4 | key 归一正则四件套（已注释「等价不修改该包」） |
| `dependency/adapters/typosquat-detector.ts` ↔ `kernel/runner/scan-utils.ts` | 2 | `escapeRegExp()` 跨包复制 |
| `dependency/adapters/upgrade-evaluator.ts` ↔ `kernel/runner/scan-utils.ts` | 2 | `escapeRegExp()` 跨包复制 |
| `db/src/types.ts` ↔ `sentinel/src/types.ts` | 2 | 类型镜像 |
| `db/src/types.ts` ↔ `shared/src/types.ts` | 2 | **shared 已存在，应改 import** |
| `desktop/electron/engine-service.ts` ↔ `server/guard/guard.service.ts` | 2 | 守卫服务逻辑 |
| `desktop/electron/ipc/engines.ts` ↔ `server/scoring/scoring.service.ts` | 4 | scoring 调用形状重复 |
| `electron/dashboard-state.ts` ↔ `electron/zh-diagnostics.ts` | 2 | 诊断聚合 |
| `electron/profile-worker.ts` ↔ `inspect/ai-code/files.ts` | 2 | 文件遍历逻辑 |
| `electron/report-summary.ts` ↔ `desktop/src/pages/domain-score-logic.ts` | 2 | 评分汇总逻辑 |

处置：B 类按「quick win 优先」推进——
1. **B1-escapeRegExp（4 条）**：dependency 包内提取 `utils/escape.ts` 并替换 2 处，kernel 侧从 dependency 引用。
2. **B1-NEWLINE_RE（4 条）**：dependency 包内提取公共正则常量模块。
3. **B1-db SQL（2 条）**：db 包内提取 `debtActionsSql` 常量。
4. **B2-shared 已存在对（6 条）**：`db/types ↔ shared/types`、`deps-baseline ↔ shared/baseline` 改 import。
5. 其余（reconcile / report-format / host 脚手架）工程量大、行为敏感，列入长期债务，暂不动。

## C. 巧合相似 / e2e 脚手架（保留）
e2e spec 间共享导航/断言脚手架，属测试并行结构，按要求保留（已有 `nav-helpers.ts` 承载，剩余为各 spec 入口差异）。

| 重复对 | 条数 | 样例证据 |
|---|---|---|
| `e2e/domain-ring-verify.spec.ts` ↔ `e2e/nav-actions.spec.ts` | 6 | `PAGE_DIMENSION` 映射 + 进入检查流程 |
| `e2e/app.spec.ts` ↔ `e2e/nav-helpers.ts` | 2 | 脚手架引用 |
| `e2e/nav-helpers.ts` ↔ `e2e/nav-probe.spec.ts` | 2 | 脚手架引用 |
| `e2e/nav-actions.spec.ts` ↔ `e2e/nav-helpers.ts` | 2 | 脚手架引用 |

## 建议的下一步
1. 本轮检测器修复已达成核心目标（203 warnings / 222 总，三规则归零），duplicated-code 不阻塞。
2. duplicated-code 治理另开一轮，按 B1 quick win（escapeRegExp、NEWLINE_RE、db SQL）+ B2 shared import 收敛，
   预计可降 12~16 条，之后再评估是否继续 B 类其余项。
3. A 类维持结构豁免，不修复（避免破坏进程边界契约）。

## 佐证工具
- 完整 JSON 快照：`/tmp/zhcheck-dedup.json`（`zhcheck --refactor --json` 输出）
- 复现脚本：`run-detect.ts`（untracked，不入库）