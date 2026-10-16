# 智汇码盾 · 重构健康度治理工作流（Refactor Health Governance）

- 日期：2026-10-15
- 状态：Accepted（待执行）
- 关联：`.omo/plans/zhcheck-duplicated-code-triage.md`（A/B/C 分诊，2026-09-30）
- 目标读者：本仓维护者（产品即工具，工具即产品——本仓是智汇码盾的自我样本）

---

## 1. 问题陈述（Why）

### 1.1 现状（2026-10-15 全量扫描，`zhcheck --refactor`）
- 630 文件、**198 坏味道**、error 0 / warning 176 / info 22。
- 重构维得分 **54.4**（≈你看到的 54.5），即 `100 − penalty`，无任何 error 级重罚。

| 类型 | 数量 | severity | 备注 |
|---|---|---|---|
| duplicated-code | 101 | warning(100)+info(1) | **占 51%，每文件计 1 条**（≈5 处重复即标记）|
| long-method | 30 | warning | 12 个行数≥80；**9 个实为圈复杂度超阈** |
| oversized-file | 22 | warning | 阈值 400 行 |
| mixed-responsibilities | 14 | warning | 阈值 3 职责 |
| feature-envy | 8 | warning | |
| lazy-class | 8 | info | |
| data-clumps | 7 | info | |
| primitive-obsession | 6 | info | |
| data-class / oversized-component | 1 / 1 | warning | |

- 分布：**desktop 119/198（60%）**；duplicated-code 中 **desktop 84/101（83%）**。生产代码 176 / 测试·e2e 22。

### 1.2 分数为何偏低（算术事实，非 bug）
```
penalty = softBand(176, 4, 40) + softBand(22, 1, 12)
        = 176×4/(1+176×4/40) + 22/(1+22/12)
        = 37.85 + 7.76 = 45.61
score   = 100 − 45.61 = 54.39 ≈ 54.4
```
- warning 已逼近软饱和上界 40（半饱和点 K=10，176 条远超 K）。分数低 = 「176 个 warning」的直接结果。

### 1.3 三条根因
1. **duplicated-code 独占半壁且是「每文件一条」低门槛标记**：不是「101 处重复」，而是「101 个文件各被标记一次」。贡献约 100 条 warning，是分数被压低的元凶。
2. **高度集中于 desktop**：清 desktop ≈ 清 60% 的问题。
3. **阈值偏严但基本合理**：400 行/80 行/复杂度 15/职责 3/重复 5 处。

### 1.4 顺带发现的工具缺陷（1 条真实 bug）
`packages/refactor/src/adapters/scale-detectors.ts:42-83` 的 long-method：
- 触发条件（L56）= `行数 > maxMethodLines(80)` **或** `圈复杂度 > maxComplexity(15)`；
- 但上报 metric 名**恒为 `methodLineCount`**，`value = max(行数, 复杂度)`（L72）。
- 后果：复杂度触发时（如 `componentNameOf()` 复杂度 19、行数 37）呈现为「37 < 80 的误报」观感，实为复杂度超阈。**标签误导，非误报。**

---

## 2. 核心原则（三条铁律）

1. **不为分数而重构**——分数是仪表盘，不是目标。禁止「调阈值/屏蔽规则」来粉饰。
2. **先修度量，再修代码**——尺子不准，一切决策皆错。
3. **只降不升（Ratchet）**——靠基线+门禁防回潮，不靠自觉。

---

## 3. 决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| ADR-1 | **阈值维持默认**（80/400/15/3/5），不登记为待调 | 不为刷分降标准；复杂度 15 命中的方法确实值得审视 |
| ADR-2 | **A 类（IPC 进程镜像）与 C 类（e2e 脚手架）机械化为豁免** | 架构强制/测试并行结构，非可消除债务（见 triage）|
| ADR-3 | **分数非 KPI**；KPI = 「相对基线的净减少」 | 防刷分，保证真实改善 |
| ADR-4 | **起点 = 阶段 0（修尺子）** | 地基优先，后续一切收益依赖可信度量 |
| ADR-5 | **基线键 = 文件路径 × 规则**（计数），非行号 id | 行号会漂移；路径×规则键稳定且可单向收缩 |

---

## 4. 工作流（4 阶段 + 治理层）

### 阶段 0 — 修尺子（让度量可信）〔约 1~2 天〕
| 任务 | 文件 | 验收 |
|---|---|---|
| P0-1 修 long-method metric 标签：按「实际主触发项」上报 metric/value/threshold（行数触发→`methodLineCount`；复杂度触发→`cyclomaticComplexity`）| `packages/refactor/src/adapters/scale-detectors.ts` | 不再出现 value<threshold 的观感误报 |
| P0-2 补 fixtures/回归测试 | `packages/refactor/src/__tests__/` | 新增「复杂度触发」用例断言 metric 正确 |
| P0-3 全绿 | `cd packages/refactor && npx vitest run` | 通过 |

**产出**：修正后的检测器 + 测试。**风险**：仅改展示字段，severity/计数不变 → 不影响分数。

### 阶段 1 — 基线 + 门禁（Ratchet）〔长期收益最大〕
| 任务 | 文件 | 验收 |
|---|---|---|
| P1-1 落地基线文件 `.refactor-baseline.json`（键=文件×规则，值=计数），首版冻结当前存量 | 仓库根 | 文件生成 |
| P1-2 `zhcheck` 支持 `--baseline`：`--ci` 仅对「超出基线的**新增**」exit 1；基线可单向收缩 | `scripts/zhcheck.mjs` | 人为加坏味道→exit 1；存量不动→exit 0 |
| P1-3 接入：pre-commit / `check:staged` 用 `--refactor --inspect --staged --baseline --ci`；CI 增加 `check:refactor:ci` job | `.github/workflows/ci.yml`、`scripts/zhcheck.mjs` `installHooks()` | ✅ 存量 exit 0；人为新增坏味道 exit 1 |

**产出**：`.refactor-baseline.json` + `zhcheck --baseline` + CI 接线。**风险**：低（新增开关，默认行为不变）。

### 阶段 2 — 分类台账 + 豁免落地（已执行）
| 任务 | 说明 | 结果 |
|---|---|---|
| P2-1 A/B/C 机器可读豁免清单 | **决策：不新建清单**。A（IPC 镜像）/C（e2e）为存量，已由 `.refactor-baseline.json` 冻结、不会计入「新增」 | 依赖基线机制即可，无需额外清单 |
| P2-2 e2e 出扫描范围 | `packages/refactor/src/engine.ts` 的 `EXCLUDED_DIRS` 加 `'e2e'`（按**目录名**匹配，不影响 `ipc/e2e-observation.ts`） | ✅ 已完成：报告不再出现 `packages/desktop/e2e/*` |
| P2-3 引擎 `ignoreGlobs` | **暂缓**：无外部项目复用需求；A 类新增镜像摩擦极低（IPC 对极少新增） | 待出现实际摩擦再做 |

**实测发现（重要）**：duplicated-code 将每个「唯一重复块」归属到**一个代表文件**。
排除 e2e 后，同一批 22 个重复块改由产品文件承担（otherDup 79→101）→ **总数不变（199→199）**。
因此 P2-2 的价值**不在降分**，而在：① 测试文件不进产品级报告；② 新增 e2e 脚手架不再阻断门禁。

**产出**：e2e 出范围 + A/C 由基线冻结（引用 triage）。

### 阶段 3 — 分级燃烧（按 ROI，不按数量）
| 层级 | 目标 | 依据 |
|---|---|---|
| Tier 1（最高 ROI）| `desktop/src/pages/*.tsx` 页面容器：long-method + mixed-responsibilities + oversized-file **同源**，抽容器/hook「一鱼三吃」| 本仓扫描 |
| Tier 2 | 生产代码 duplicated-code 的 **B1 quick win**：`escapeRegExp`、`NEWLINE_RE`、db SQL 常量、shared 已存在类型改 import | triage B1/B2 |
| Tier 3 | B2 其余（reconcile / report-format / host 脚手架）| triage|

**每单铁律**：提交前用 `zhcheck --refactor --staged` 做**前后对比**，要求「本类净减、且不新增其他类」（避免历史上「消 long-method 却涨 oversized-file」）。

### 阶段 4 — 制度化
1. **DoD 含坏味道预算**：新功能/新文件不得让检测器新增（P1-2 门禁强制）。
2. **新文件硬约束**：≤400 行；方法 ≤80 行；复杂度 ≤15。
3. **周期全量报告 + 趋势**：用软饱和分数（已修正为单调）真实反映清理成效。

### 治理层（跨阶段）
- 分数只做展示，不进考核。
- 每次豁免/阈值变更必须写 ADR。
- 基线只增「永不收缩」条目（架构性）；一次性债务条目只减不增。

---

## 5. 执行看板（逐条勾选）

- [x] **P0-1** 修 long-method metric 标签（`scale-detectors.ts`）
- [x] **P0-2** 补复杂度触发回归测试（`packages/refactor/src/__tests__/engine.test.ts`）
- [x] **P0-3** `cd packages/refactor && npx vitest run` 全绿（66/66）
- [x] **P1-1** 生成 `.refactor-baseline.json`（冻结存量，110 文件 / 199 条）
- [x] **P1-2** `zhcheck` 增加 `--baseline` / `--write-baseline`（`--baseline --ci` 仅对新增 exit 1）
- [x] **P1-3** CI 接入 baseline 检查（`check:refactor:ci`）；pre-commit / `check:staged` → `--refactor --inspect --staged --baseline --ci`
- [x] **P2-1** A/B/C 豁免清单 → 决策：由基线冻结替代（见阶段 2）
- [x] **P2-2** e2e 出扫描范围（`EXCLUDED_DIRS` + `'e2e'`）
- [x] **P2-3** `ignoreGlobs` → 暂缓（见阶段 2）
- [ ] **P3-1** Tier1：desktop 页面容器抽 hook/组件（逐文件）
- [ ] **P3-2** Tier2：B1 quick wins（escapeRegExp / NEWLINE_RE / db SQL / shared import）
- [ ] **P4-1** DoD & 新文件约束写入贡献指南

---

## 6. 验收总则

- 每个 PR：`zhcheck --refactor --staged` 相对基线**净增 ≤ 0**。
- 阶段 0：`packages/refactor` 测试全绿，metric 自洽。
- 阶段 1：`--ci` 对存量放行、对新增拦截。
- 全程：`node scripts/typecheck.mjs` 21/21；相关包测试全绿。

## 7. 复现命令

```bash
# 全量重构扫描（当前仓）
node scripts/zhcheck.mjs --refactor

# JSON 快照（需去日志前缀）
node scripts/zhcheck.mjs --refactor --project . --json > /tmp/refscan.txt

# 暂存区门禁（pre-commit 口径）
node scripts/zhcheck.mjs --refactor --inspect --staged --ci

# 单包测试
cd packages/refactor && npx vitest run
```

## 8. 数据快照（2026-10-15）
- 原始 JSON：`/tmp/refscan_raw.txt`（本地临时，不入库）
- 计数：见 §1.1 表格。
