# 智汇码盾 CI/CD 集成蓝图与开发规格

> 版本：v0.1.0-draft ｜ 日期：2026-08-28 ｜ 状态：**开发依据（Single Source of Truth）** ｜ 备注：§1 已澄清「检测 + 分派」模型
> 适用范围：智汇码盾（zhiyan-codeshield）GitHub / CI/CD 集成相关全部开发
> 维护原则：本文档是该类需求的唯一权威来源；任何范围变更必须先更新本文档再开发

---

## 0. 防漂移原则（最高优先级）

1. **唯一依据**：所有 CI/CD 集成相关开发必须对照本文档第 5/6/7 节验收清单执行，不得凭口头需求或单轮对话判断。
2. **变更流程**：需求扩大 / 收缩 → 先改本文档 → 评审 → 再编码。
3. **边界不可漂移**：智汇码盾是**守护层**，采用「**检测 + 分派**」模型——自身只做检测、报告、门禁、监控、告警、手动备份（非破坏复制），**绝不自动修改/删除/重构/优化代码**。所有「动手改代码」的动作（冗余代码删除、性能优化、依赖升级、代码重构等）只产出结构化清单并分派给其他 AI 开发工具执行（见第 1 节）。任何在默认工作流中自动修改代码、自动开修复 PR 的行为均属越界，禁止。
4. **0Token 不可漂移**：默认工作流只允许运行第 2.5 节列出的 0Token 能力；需 token 的 LLM/后端能力默认关闭，仅作为可选增值（第 7 节）。

---

## 1. 产品定位与边界（不可漂移的基线）

| 维度 | 智汇码盾负责（检测 / 报告 / 门禁 / 监控 / 告警 / 手动备份） | 其他 AI 开发工具负责（执行修复） |
|---|---|---|
| 代码检查 / 质量 / 技术债务 | ✅ | |
| 安全守护 / 漏洞与密钥扫描 / 密钥泄露 | ✅ | |
| 治理 / 架构与规范门禁 | ✅ | |
| 运维 / 运行时监控告警 / 手动备份 | ✅ | |
| 冗余代码 / 垃圾文件清理（删除动作） | 检测 + 清单 | ✅ 执行删除 |
| 性能优化（改代码） | 检测 + 清单 | ✅ 执行优化 |
| 依赖升级 / 修复漏洞依赖 | 检测 + 清单 | ✅ 执行升级 |
| 代码重构 | 检测 + 建议清单 | ✅ 执行重构 |
| 修复 / 迭代 / 升级（总括） | | ✅ |

**推论（设计铁律）：**
- 智汇码盾是**独立守护层**，与生成代码的 AI 工具职责分离（生成与审查分离）。
- **检测 + 分派模型**：智汇码盾只做「查」（检测、报告、门禁、监控、告警、手动非破坏备份），不做「改」。凡涉及改动代码/文件的动作（删除冗余、性能优化、依赖升级、重构），只产出结构化问题清单，分派给其他 AI 开发工具执行；自身绝不写 / 删 / 改代码。
- 在 CI 合入门禁处，由智汇码盾做一道**独立、可信的守护检查**；产出**诊断报告 + 门禁决策**，不开修复 PR。
- 正确产出形态：检查 → 标准格式报告（SARIF / JSON 问题清单）→ 分派其他 AI / PR 评论 / 状态检查 / Annotations → 门禁失败时阻断合并。

**四大能力域：**
- `guard` 门禁 ｜ `inspect` 巡检 ｜ `security` 安全扫描 ｜ `sentinel` 监控

### 1.1 服务清单与职责边界（检测 + 分派）

智汇码盾对外提供 11 项能力，统一遵循「只检测、不改动」原则；凡需改代码的动作只出清单、分派其他 AI。

| 服务 | 类别 | 智汇码盾自身 | 其他 AI |
|---|---|---|---|
| 门禁检查 (guard) | 检测+门禁 | 检测 + 阻断决策 | — |
| 哨兵监控 (sentinel) | 运维监控 | 只读监控 + 告警 | — |
| 项目体检 (inspect) | 检测+报告 | 检测 + 报告 | — |
| 安全扫描 (security) | 检测 | 漏洞/密钥/依赖风险检测 | — |
| 依赖管家 | 检测 | 报漏洞/过期依赖 | 执行升级 |
| 技术债务 | 检测+报告 | 检测 + 报告 | — |
| 报告中心 | 汇总 | 聚合展示 | — |
| 备份中心 | 运维保障 | 手动/定时**非破坏复制** | — |
| 垃圾清理 | 检测→分派 | 检测冗余代码/垃圾文件 + 清单 | 执行删除 |
| 性能优化 | 检测→分派 | 检测性能问题 + 清单 | 执行优化 |
| 代码重构 | 检测→分派 | 检测重构点 + 建议清单 | 执行重构 |

> 红线：备份中心是「复制」不是「改动」，不视为改代码；清理/优化/重构的「动手」动作一律分派，智汇码盾自身永不直接修改源码。

---

## 2. 当前状态基线（核查事实，防遗漏）

> 以下为 2026-08-28 核查所得真实状态，作为后续开发的起点参照。

### 2.1 集成面现状
- **已接入**：opencode MCP server（`runGuard` / `runInspect` + 只读 `getDiagnostics/getIssues/getIntegration`）、本地 git pre-commit hook、Electron 桌面 UI 手动触发。
- **未接入**：无 GitHub Action、无工作流模板、无公开 GitHub 仓库、CLI 未发布 npm（`package.json` 标 `"private": true`）。
- **CI 现状**：`.github/workflows/ci.yml` 仅运行 build / typecheck / test / lint，**不调用 `zhshield`**。
- **后端**：`api.zhishield.com` / `zhishield.com` 均不可达（HTTP 000），产品当前为离线优先。
- **死配置**：`.zhshield/integration.json` 的 `on_save/on_commit/on_file_change` 无代码读取，仅为 AI agent 的建议文本。

### 2.2 四大能力触发路径（实际代码级）
| 能力 | MCP | CLI | 桌面 UI | HTTP | git hook | 定时 |
|---|---|---|---|---|---|---|
| guard | ✅(dryRun) | ✅ | ✅ | — | ❌(hook 只跑 refactor+inspect) | ❌ |
| inspect | ✅ | ✅ | ✅ | ✅ | ✅(--refactor --inspect) | ✅(每日 00:00) |
| security | ❌ | ❌(仅 guard pipeline 内) | ✅ | ✅ | ❌ | ❌ |
| sentinel | ❌ | ❌ | ✅(手动 start) | ✅(webhook) | ❌ | ❌ |

> 唯一真正"自动"的触发 = git pre-commit hook，且仅跑 refactor + inspect。

### 2.3 引擎实现事实
- **guard**：`GuardEngine`，checks.json 模式（ARCH/LINT/TEST/SEC 四检查）+ SOP 模式（YAML 规则）。
- **inspect**：`InspectEngine`，外部 CLI 驱动（eslint / gitleaks / semgrep / depcruise / jscpd / ts-prune / depcheck）+ 自研 AI review（非阻断）。
- **security**：`SecurityEngine`，自研为主（vulnerability-scanner 调 `npm/pnpm/poetry/pip-audit` + 自研 malware/garbage/injection/supply-chain 启发式）。
- **sentinel**：`@zh/sentinel` 库，嵌 Electron 主进程；FileMonitor(fs.watch+轮询) / LogCollector(轮询) / ProcessMonitor(spawn+健康检查)，事件入 SQLite。

### 2.4 已知落差（必须在 P0 闭合）
1. **Trivy 在 security 生产路径未接上**：`@zh/security` 的 trivy/grype 等适配器在生产实例化时未注册（死代码）；Trivy 目前仅 `guard` 的 `GuardTrivyAdapter` 使用。
2. **规则疑似运行时从后端同步**（如 `startPeriodicSync` 拉 SOP 缓存 / wisdom brain）。离线 CI 无法依赖此机制。
3. **CLI 不可独立安装**：依赖 `tsx` 跑源码、依赖整个 monorepo 树，CI 中无法 `npx zhshield`。

### 2.5 零 Token 边界（引用 `00-项目文档/00-总览/零Token模式能力边界图.md`）
**✅ 可检测（零 Token，全本地/开源 CLI）：**
代码风格(ESLint) ｜ 安全漏洞(Semgrep+Trivy) ｜ 密钥泄露(gitleaks) ｜ 依赖风险(depcheck+Trivy) ｜ 架构违规(dependency-cruiser) ｜ 代码异味(自研) ｜ 重复代码(jscpd) ｜ 死代码(ts-prune) ｜ 供应链仿冒包(自研)。

**❌ 不可检测（需 LLM，默认排除）：** 业务逻辑错误 ｜ 设计模式误用 ｜ 命名语义合理性 ｜ 算法正确性（即 AI code review 范畴）。

---

## 3. CI/CD 集成决策（结论）

| 问题 | 结论 |
|---|---|
| 是否需要对接 CI/CD | **战略需要；战术上 P1**（排在 P0 前置之后） |
| 采用形态 | **A 方案**：官方 GitHub Action + 工作流模板，用户几行 YAML 启用 |
| 是否 0Token | 默认工作流**仅跑第 2.5 节 9 类**，排除 LLM；0Token 成立 |
| 是否修复 | **不修复**（第 1 节铁律）；产出报告 + 门禁，不开修复 PR |
| 排除方案 | **B 方案（SaaS 平台托管 + 自动修复）** 越界，不采用 |

**为何需要（定位支撑）：** 智汇码盾是独立守护层，必须在代码合入门禁被独立调用；生成代码的 AI 工具不自查，需独立守护层卡点。目标用户"所有开发者"中绝大多数不在 opencode 内，GitHub 是其默认协作面。

---

## 4. 开发优先级路线图

```
P0-1  CLI 可独立安装化        ──┐
P0-2  0Token 规则自包含       ──┤ 前置（无此则 CI 跑不了/跑空）
P0-3  Trivy 接通 security 路径 ──┘
        │
        ▼
P1    官方 GitHub Action + 工作流模板   ← CI 集成落地（只检查不修复，0Token）
        │
        ▼
P2    (可选) 后端服务 + token 体系 + AI review 增值
```

---

## 5. P0 规格与验收标准

### P0-1 CLI 可独立安装化
- **目标**：CI 中可通过 `npx zhshield@x` 或 Action 内置方式调用，无需整个 monorepo 源码。
- **要求**：
  - 发布 `@zh/cli` 到 npm（移除 `"private": true`），或产出 standalone 可执行 build。
  - `bin/zhshield` 不再依赖 `tsx` 现场跑 TS 源码；打包为可执行产物。
  - 核心引擎（guard/inspect/security）随 CLI 发行，不依赖仓库其余包开发态。
- **验收**：在干净容器（无 monorepo）中 `npx zhshield guard --dir . --dry-run` 可运行并产出报告。

### P0-2 0Token 规则自包含
- **目标**：离线 CI 不依赖后端即可获得完整规则。
- **要求**：
  - SOP 规则 / 检查规则 / 知识库随 CLI / Action 发行物**打包**，而非运行时从 `api.zhishield.com` 拉取。
  - 移除或降级对 `startPeriodicSync` 后端同步的硬依赖（离线可用）。
- **验收**：断网环境下 `zhshield guard/inspect` 仍可加载全部 0Token 规则并运行。

### P0-3 Trivy 接通 security 路径
- **目标**：文档承诺的"安全漏洞 / 依赖风险 0Token 检测"在 security 路径真实可用。
- **要求**：
  - 在 `SecurityEngine` 生产路径注册 Trivy 适配器（或明确 0Token 安全扫描改走 `guard` pipeline 的 `GuardTrivyAdapter`）。
  - 统一 Trivy 调用入口，消除"guard 用、security 不用"的分裂。
- **验收**：`zhshield` 安全扫描能产出 CVE / 依赖风险结果，且不依赖死代码路径。

---

## 6. P1 规格（CI 集成）与验收标准

### 6.1 官方 GitHub Action（`action.yml`）
- **输入**：`dir`（默认 `.`）、`mode`（`guard`/`inspect`，默认 `guard`）、`sop`（bool）、`fail-on`（默认 `error`，**仅 guard/refactor/pipeline 生效；inspect 固定仅报告忽略此值**）、`format`（默认 `sarif`）。
- **输出**：`report`（问题清单路径）、`exit-code`。
- **约束**：
  - Action 内部负责安装开源工具（eslint / gitleaks / semgrep / depcruise / jscpd / ts-prune / depcheck / trivy），用户 0 配置。
  - **禁止**任何自动修改代码 / 自动开修复 PR 的步骤。
  - 默认**不启用** LLM / AI review / 任何需 token 的能力。

### 6.2 工作流模板（`zhshield.yml`）
```yaml
name: ZHCodeShield Guard
on: [push, pull_request]
jobs:
  shield:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: liangdawei3927-commits/zhshield-action@v1   # 官方 Action（P1 产出）
        with:
          mode: guard
          format: sarif
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: zhshield.sarif
```
- **触发**：`push` + `pull_request`。
- **门禁**：发现 `error` 级问题 → 非零退出 → 阻断合并（通过状态检查）。
- **报告**：SARIF / JSON 问题清单；PR 评论或 Annotations 展示（使用自动 `GITHUB_TOKEN`，非用户 token）。

### 6.3 0Token 约束（强制）
- 默认工作流仅包含第 2.5 节 9 类能力。
- 规则已自包含（P0-2），不访问后端。
- 开源工具由 Action 内置安装。

### 6.4 验收清单（P1）
- [ ] 存在 `action.yml`，输入/输出/约束符合 6.1。
- [ ] 工作流模板可 copied 入任意仓库即运行，用户无需 token / 无需手动装工具。
- [ ] 默认运行不触发任何代码修改、不开修复 PR。
- [ ] 断网（仅 GitHub runner 基础网络）下 0Token 9 类检测可完成。
- [ ] `error` 级问题导致合并被状态检查阻断。
- [ ] SARIF 成功上传并在 Security 面板 / PR 展示。
- [ ] 同类工具（ggshield / Semgrep）的接入体验不被显著劣化。

---

## 7. P2 规格（可选增值，非 0Token）

- **后端服务 + token 体系**：多租户、规则云端管理、趋势分析。
- **AI review 增值**：将第 2.5 节"需 LLM"的 4 类作为**可选能力**，仅当用户显式配置 `LLM_TOKEN` 时启用，且**不参与默认门禁阻断**。
- **约束**：P2 能力绝不下沉为默认 0Token 工作流的一部分（防漂移第 0.4 条）。

---

## 8. 防漂移验收总表

| # | 必须满足 | 禁止 |
|---|---|---|
| 1 | 默认工作流仅含 0Token 9 类能力 | 默认启用 LLM / AI review |
| 2 | 官方 Action 内置安装开源工具 | 要求用户手动配置 token 才能跑基础检查 |
| 3 | 产出诊断报告 + 门禁决策 | 自动修改代码 / 自动开修复 PR |
| 4 | 规则随发行物自包含 | 运行时强依赖不可达的后端 `api.zhishield.com` |
| 5 | CI 集成排在 P0 前置闭合之后 | 在 CLI 不可安装时就发布空壳工作流 |
| 6 | 文档变更优先于代码变更 | 凭单轮对话扩大/缩小范围 |

---

## 9. 附录：事实与文件索引

**核查来源（2026-08-28）：**
- 仓库：`/Users/dawei/Desktop/ZHCodeShield/zhiyan-codeshield/`（私有 monorepo，无 git remote）
- 零 Token 边界：`00-项目文档/00-总览/零Token模式能力边界图.md`
- CI 现状：`.github/workflows/ci.yml`（仅 build/test/lint）
- CLI：`packages/cli/src/index.ts`（guard/inspect/refactor/pipeline，无 `--ci`/`--format`/`--token`）
- guard：`packages/guard/src/engine.ts`、`hooks-installer.ts`
- inspect：`packages/inspect/src/engine.ts`、`adapters/*`
- security：`packages/security/src/engine.ts`（trivy/grype 适配器未在生产注册）
- sentinel：`packages/sentinel/src/*`（FileMonitor/LogCollector/ProcessMonitor/EventCenter）
- 集成面：`packages/desktop/electron/zhshield-mcp.ts`（仅 runGuard/runInspect + 只读）

**决策依据对话**：定位（守护层/只检查不修复）→ 战略需要、P1 落地、A 方案、0Token 9 类。
