# 生产修复工作流（2026-11-14）

> 本文档记录 2026-11-14 全面检查后确认的**真实缺陷**、根因证据、修复方案与验收判据，并**明确排除**了本轮复查中推翻的误报。
> 原则：以代码与实测为准；每条缺陷都必须有可复现的证据；修完必须过对应验收；不夹带无关重构。

## 0. 修复原则

- **最小改动**：只改造成缺陷的必要部分，不顺手重构、不引入新依赖。
- **证据先行**：每条缺陷先有复现，再动手；修完用同一判据复测。
- **测试与 typecheck 严禁并行**（AGENTS.md）。
- **改 src 必须重建 bundle**：`packages/cli/dist/zhshield.js` 提交进 git，CI 用 `verify:dist-fresh --no-build` 比对工作区构建与 HEAD 产物。
- 文档与实现冲突时以代码行为为事实，并回头修文档。

## 1. 缺陷清单与修复顺序

| 顺序 | 编号 | 缺陷 | 性质 | 证据强度 | 验收判据 |
|---|---|---|---|---|---|
| 1 | F1 | A12 失效：同参 semgrep 在一轮内派发 2 次 | 真实缺陷 | 已复现 2 次 | `verify:tool-dedup` 全链 PASS |
| 2 | F2 | lint 3 条 warning，desktop 用 `--max-warnings 0` | 真实缺陷（CI 拦截） | 已复现 | `pnpm lint` exit 0 |
| 3 | F3 | 门禁结论模式被「扫描器未注册」提前短路 | 真实缺陷（产品） | 单测失败 + 源码顺序可证 | 该用例转绿且不动断言 |
| 4 | F4 | guard 用例 mock 违反 Node 回调契约 | 用例过时（非产品缺陷） | 已定位 | 该用例转绿，产品代码不动 |
| 5 | F5 | semgrep 产出绝对路径，落盘口径不统一 | 真实缺陷（一致性） | 实测 11/25 条 | 扫描产物中 0 条绝对路径 |
| 6 | F6 | 服务端 tool-rule-loader 默认路径指向已删目录 | 真实缺陷（降级兜底失效） | 实测 `loadAll() = 0` | 注释/文档与现状一致，不再误导 |

---

## 2. 逐项详情

### F1 — A12 失效：同参 semgrep 一轮派发 2 次（P0）

**现象**（`verify:tool-dedup` 全量扫描链，复现 2 次）：

```
VIOLATION 同一 (tool, args) 起了多次扫描进程:
  semgrep × 2: scan --json --optimizations all \
    --config .../kernel/dist/assets/semgrep/path-traversal.yml \
    --exclude node_modules ... /Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield/packages
```

**对照实验**（关键，决定根因）：

| 运行方式 | inspect 状态 | 结果 |
|---|---|---|
| 全量扫描链 | `unavailable (overBudget)` | **VIOLATION** |
| 仅 `--domains inspect,security` | `partial`（未超预算） | **PASS** |

**根因**：inspect 域预算 `SCAN_DOMAIN_BUDGETS.inspect = 150_000ms`，而 inspect 单跑实测 **146.86s**，处于预算边缘。全链运行时 inspect 超预算 → `withHardTimeout` 抛出 → `attachKilledProcesses` 调 `killAll()` 强杀该域仍在跑的 semgrep 子进程 → 该次调用结论「不明确」→ `tool-run-scope.ts` 的 `isConclusive` 判否，按契约**从重放表剔除**（"结论不明确的失败不进重放表：下次调用应真的重试"）→ security 域随后用**完全相同的 argv** 再派发一次。

因此去重机制本身工作正常，**问题是上游把一次可复用结果强杀掉了**。

**被推翻的错误假设**：上一轮报告称根因是「两条规则的 `toolConfig` 中 `mitigations` 字段不同导致去重键不一致」。该假设**不成立**——同一作用域内的两个域专跑结果为 PASS，若真是键不一致，两域专跑也应 VIOLATION。已废弃。

**修复**：提高 `inspect` 域预算，给实测耗時留出余量（`150s → 240s`，实测 146.86s + 约 60% 余量；security 域既有 300s 即同一量级口径）。
- 落点：`packages/shared/src/domain-contract/capability-registry.ts` 的 `SCAN_DOMAIN_BUDGETS.inspect`

**验收**：全链 `node scripts/verify-tool-dedup.mjs` 为 PASS，且 inspect 不再 `overBudget`。

**遗留**：若后续仓库继续变大，inspect 仍可能触顶。真正的结构性修法是让「域超预算强杀」不牵连已完成的工具结论，但那属于执行器语义变更，需单独决策，本轮不做。

---

### F2 — lint 3 条 warning（P0，CI 拦截）

```
packages/desktop/electron/report-summary.ts:12  'buildHealthDimensions' / 'SCORE_VERSION' 未使用
packages/desktop/src/pages/category-score-cards.tsx:1  'ScoreDimension' 未使用
```

`packages/desktop` 的 lint 脚本为 `--max-warnings 0`，CI 有独立 `lint` job 跑 `pnpm lint`，因此这 3 条会真实拦红。三者均为纯类型/值导入且确无引用（`buildHealthDimensions` / `SCORE_VERSION` 仅在注释里被提及）。

**修复**：删除 3 处未使用导入。

**验收**：`pnpm --filter @zh/desktop exec eslint src electron --max-warnings 0` exit 0；`pnpm lint` 全绿。

---

### F3 — 门禁结论模式被「扫描器未注册」提前短路（P1，真实产品缺陷）

**现象**：`packages/kernel/src/__tests__/guard-conclusion.test.ts` 中「多个 scanner 读到同一域结论时只计一次」失败：

```
expected 'skipped' to be 'failed'
```

**根因**（源码顺序可证）：`dispatch-engine-scan.ts` 的 `runScannerAdapters → scanWithOneScanner`：

```ts
// ① 先判「适配器是否注册」，未注册直接 return ran:false
if (!host.toolAdapters.has(toolName)) {
  return { ran: false, violations: [], reason: `${toolName}(未注册工具适配器: ${toolName})` };
}
// ② 之后才进 evalToolDispatch → isGuardConclusionMode → evalGuardConclusion
const one = await evalToolDispatch(...)
```

门禁进入**结论模式（O8）**时本不该启动任何工具，也就不该要求工具适配器已注册。但 ① 在 ② 之前无条件执行，于是规则声明 `scanners: ['semgrep','gitleaks']` 而宿主只注册了 eslint 时，两个 scanner 全部走 ①，`anyRan=false` → 整体判 `skipped`。后果是**门禁静默丢掉跨域阻断项**——正是 `delegationGate` 注释里刻意防范的那种失效（"若也让位，门禁会静默丢掉跨域阻断项"）。

**修复**：在 `scanWithOneScanner` 中把结论模式判定提到注册检查之前——结论模式下直接走 `evalToolDispatch`（其内部会转 `evalGuardConclusion`），不要求适配器已注册；非结论模式保持现有「未注册即记原因」的行为不变。

**验收**：该用例转绿且**不改任何断言**；`@zh/kernel` 全量单测无新增失败。

---

### F4 — guard 用例 mock 违反 Node 回调契约（P1，用例过时）

**现象**：`packages/guard/src/__tests__/guard-skip-semantics.test.ts` 中「有 eslint.config.js 时不跳过」失败：

```
expected 'error' to be 'warning'
```

**根因**：用例把 `node:child_process` 整体 mock 成 `(...args) => execFileMock(...args)`，回调传 `cb(null, { stdout, stderr })` —— 把**对象当作 stdout**。而产品侧已改走 `runToolOnce → promisify(execFile)`，按真实 Node 契约取第二参数，得到 `"[object Object]"`，`JSON.parse` 失败 → 判 `error`。真实契约应为 `cb(null, stdoutString, stderr)`。

附带问题：包装版 mock 丢弃了 `util.promisify.custom`，`promisify(execFile)` 会退回「回调单值」形态（`scripts/lib/tool-spy.cjs` 的注释已记录过这个坑）。

**修复**：只改用例——回调按真实契约传字符串，并给 mock 补上与原生等价的 `promisify.custom`。**产品代码不动。**

**验收**：该用例转绿；`@zh/guard` 全量单测无新增失败。

---

### F5 — semgrep 产出绝对路径（P2，落盘口径不统一）

**现象**：同一份夹具扫描，25 条违规中 11 条 `file` 是绝对路径（如 `/tmp/.../src/index.ts`）。

**根因**：`@zh/shared` 的 `semgrepMapper` 直接写 `file: r.path || ''`，没有相对化；同仓 gitleaks 适配器则有 `normalize()` 做 `path.relative`。仓库口径（`domain-contract/path.ts` 注释）明确：**落盘/存储一律 `toRelativePath(projectRoot, file)`**，理由是曾出现 `file:///tmp/p/tmp/p/src/a.ts` 双拼 URI 导致跳转全部 404。

**修复**：在 semgrep 适配器的 `mapOutput` 中用 `toRelativePath(options.projectPath, issue.file)` 归一化（security 侧 `mapOutput` 已能拿到 `projectPath`；inspect 侧同理）。未改动 `@zh/shared` 的通用 mapper 签名，避免影响其他调用方。

**验收**：同一夹具扫描产物中绝对路径条目为 0；`@zh/security`、`@zh/inspect` 单测通过。

---

### F6 — tool-rule-loader 默认路径指向已删目录（P3，降级兜底失效）

**现象**：

```
[ToolRuleLoader] Packs directory not found: .../packages/kernel/src/sop/tool-packs
loadAll count: 0
```

**根因**：默认路径写死 `kernel/src/sop/tool-packs`，该目录在提交 `a004661`（C6：删源规则）时已删除，实际内容在 `kernel/test-fixtures/sop-content/tool-packs`。

**影响有限**：服务端正常路径从 DB 读（`tool_package` 有 active 包），文件系统只是兜底；但兜底必然为空，且代码注释与 README 仍在教人往这个不存在的目录加规则，会误导维护。

**修复**：不把默认路径指向 test-fixtures（测试数据不该成为生产兜底）。改为：保留「无目录则空包」的降级，同时**修正注释**说明兜底已停用、规则应以 DB 为准；并在启动日志里把「空包」标为预期行为而非异常。README/文档中指向该目录的表述一并更正。

**验收**：`loadAll()` 行为不变（仍为空、不崩），注释与文档不再指向已删目录。

---

## 3. 本轮明确排除（不是缺陷）

| 项目 | 上一轮的结论 | 本轮复核结论 |
|---|---|---|
| CLI bundle 过期 | ❌ 报为缺陷 | **误报**。在干净 HEAD 工作树运行 `verify-dist-fresh --no-build` 得 `✅ 与源码一致（98fa042e36827327）`；此前告警源于拿工作区（含未提交改动）产物比对 HEAD 产物 |
| 性能域未报 `matrix[i][j].length` 三重循环 | ❌ 疑似漏检 | **按设计**。该形态遍历同一三维数组，总代价等于元素总数，不构成乘数放大；三个独立维度 `n×m×p` 实测可正常检出 |
| `techdebt` 域 CLI 下 not-run | — | **按设计**。需宿主注入执行器，`not-run` 不计失败 |
| guard 用例失败即产品缺陷 | ❌ 初判为产品 | **用例过时**（见 F4），产品行为正确 |

## 4. 执行顺序与状态

- [x] F1 A12 预算修复（`inspect: 150s → 240s`，同步改 `domain-contract.test.ts` 断言）
- [x] F2 lint 3 条 warning（删除未使用导入；`desktop` lint `--max-warnings 0` exit 0）
- [x] F3 结论模式短路（`scanWithOneScanner` 先判结论模式；kernel 98 文件 / 943 用例全绿）
- [x] F4 guard 用例 mock 契约（用例侧修正 + 补 `promisify.custom`；guard 11 文件 / 131 用例全绿）
- [x] F5 semgrep 路径相对化（两侧 mapper 加 `projectRoot`；**fingerprint 保持原口径**，见下方注意）
- [x] F6 tool-rule-loader 注释与 README 更正（行为不变）
- [x] 收尾：重建 CLI bundle（在 `/tmp/zh-fix` 干净 worktree 中构建，指纹 `a688bf44122a6f2b` / 434 文件；
      `grep "Users/"` 与 `grep "/tmp/zh-fix"` 均为 0；已提交 `3d5c2c0`）

### 执行中发现的额外约束（重要）

**F5 不能连带改 `fingerprint`。** `Issue.fingerprint` 是白名单 / 豁免 / 冲突归一的**身份键**
（`rule-conflict-resolver.ts`、`cross-validator.ts` 都按它匹配）。把 `file` 相对化后若让
fingerprint 跟着变，会让用户已有的豁免条目**静默失效**，且 security 侧仍用原口径 →
两侧键空间分叉。因此 F5 只改 `file`（展示/跳转用），fingerprint 保持 semgrep 原样 `r.path`。
inspect 单测 `semgrep-batch.test.ts` 对此有断言锁定。

**bundle 不能在工作区重建。** 执行时工作区存在其他会话未提交的 `packages/*/src` 改动
（`shared/src/capability-registry.ts`、未跟踪的 `node-builtins.ts` 等）。按 AGENTS.md，
此时直接 build 等于替别人决定「这些小改可以发布」。故在
`git worktree add /tmp/zh-fix HEAD` 里**真实安装依赖**（不可软链）后构建，产物经两条自查：
`grep -c "Users/" = 0`、`grep -c "zh-fix" = 0`。
