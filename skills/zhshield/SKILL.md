---
name: zhshield
description: 通过智汇码盾 MCP 工具获取项目代码健康度、结构化治理发现与门禁结果。当用户询问代码质量、安全隐患、技术债、依赖或重构前基线时使用。不用于纯代码编写或单文件风格调整。
---

# 智汇码盾（zhshield）

判断项目健康度时不要凭阅读猜测，调用本工具拿结构化发现。工具返回的是**最近一次体检**的缓存结果，不是实时分析。

## 五个工具

| 工具 | 作用 | 关键参数 | 何时调用 |
|---|---|---|---|
| `getIssues` | 取最近一次体检的 issues，可按严重等级/类别/来源过滤 | `projectPath`（可省，默认 cwd）、`severity`、`category`、`source`、`limit`（默认 50） | **首选入口**。需要具体问题清单时 |
| `getDiagnostics` | 取原始体检诊断 JSON | `projectPath`（可省） | 需要完整报告而非过滤后的 issues 时 |
| `runInspect` | 重新执行巡检，刷新诊断 | `projectPath`（**必填**）、`sop` | 代码改动后需要最新结果时 |
| `runGuard` | 执行门禁检查（dry-run 只报告不阻断） | `projectPath`（**必填**）、`sop` | 提交/合并前，或用户明确要求门禁 |
| `getIntegration` | 读取 `.zhshield/integration.json` 集成配置 | `projectPath`（可省） | 排查自动触发/过滤器/自动修复为何未生效 |

## 四个标准流程

**A. 项目健康快照（最常用）**
1. `getIssues({ projectPath })` —— 新项目会自动触发首轮巡检，无需先调 `runInspect`
2. 汇报时先给总数与 error/warning 分布，再列最需要处理的若干条，附 `文件:行`

**B. 代码改动后复查**
1. `runInspect({ projectPath })` 刷新缓存
2. `getIssues({ projectPath })` 读新结果
3. 对比改动前后的数量变化，说明是变好还是变差

**C. 提交/合并前门禁**
1. `runGuard({ projectPath })`
2. 读返回结果中的未通过项；需要逐条细节时再调 `getIssues({ source: 'guard' })`

**D. 按维度深挖**
用 `getIssues` 的过滤器逐步收窄，不要全量反复拉取：
`severity: 'error'` → `source: 'inspect'` → `category: '<具体类别>'`

## 输出解读

- `issues[]` 是**代码发现**，每条含 `ruleId` / `severity` / `category` / `message` / `file` / `autoFixable` / `source`
- `severity` 只有三档：`error` / `warning` / `info`
- `source` 共七种：`guard`（门禁）/ `inspect`（巡检）/ `refactor`（重构分析）/ `deps`（依赖）/ `security`（安全）/ `techdebt`（技术债）/ `performance`（性能）。结果按域聚合，不是只有最后跑的那个引擎
- 返回体带 `total`（过滤后总数）、`returned`（本次实际返回）、`truncated`（是否被截断）。**`truncated` 为 true 时不要直接下结论**：说明还有更多问题，应继续用过滤器收窄或告知用户总数
- `toolErrors` 是**外部工具的执行状态**（trivy、依赖审计等的报错原文），**不是代码缺陷**。不要把它混进问题清单汇报给用户
- 无数据时返回的 `bootstrapped: true` 表示已自动跑过首轮巡检

## 成本与反模式

- **`runGuard` 可能真实执行测试套件**（冷缓存可达数分钟）。用户没要求门禁时不要调用
- 不要连续重复调用同一读取工具：结果来自缓存，重复调用不产生新信息
- 不要在没有 `runInspect` 的情况下宣称"已修复"：缓存未刷新时看到的是旧状态
- 不要把 `toolErrors` 当 findings 汇报
- 不要用本工具替代静态阅读：需要理解具体实现逻辑时，仍然要读源码

## 汇报约定

1. 先给结论（健康度或数量分布），再给证据（规则 id + 文件位置）
2. 区分"必须修"（error）与"建议修"（warning/info），不要平铺
3. 明确指出结果是基于缓存还是刚刷新的
