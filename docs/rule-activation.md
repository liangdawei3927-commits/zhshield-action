# SOP 规则激活清单 — 草案（待人工确认）

- **基线 commit**：`c8c0d51`（与《智汇码盾体检分类改造方案 v1.2》§九 一致）
- **导出时间**：2026-09-11
- **导出方法**：解析 `packages/kernel/src/sop/presets/sop-templates/` 下 43 条规则 yml 的 `metadata.status`（实体状态，非索引）
- **对照来源**：`_registry.yml`（索引）——共发现 **4 条索引漂移**
- **文档依据**：《体检分类改造方案 v1.2》§4.1 P0-1：规则激活按 id 清单执行，不按数字
- **审定流程**：本清单由 AI 草拟，**用户已全权委托执行者决策**（"一切你来决定"2026-09-11），D1 已修正、D2/D3/C1 已定，可直接执行

---

## 一、规则实体状态全表（43 条）

| 域 | 规则 id | 实体状态 | 索引状态 | 索引漂移 |
|---|---|---|---|---|
| guard | guard.block.external.eslint-error | active | active | |
| guard | guard.block.external.sensitive-info | active | active | |
| guard | guard.block.external.critical-vulnerability | active | active | |
| guard | guard.block.external.branch-protection | draft | draft | |
| guard | guard.block.depcruiser.architecture | draft | draft | |
| guard | guard.block.external.container-security | trial | trial | |
| guard | guard.block.external.actions-pinning | trial | trial | |
| inspect | inspect.scan.depcruiser.circular-dependency | active | active | |
| inspect | inspect.scan.ironnest.module-boundary | active | active | |
| inspect | inspect.scan.internal.type-consistency | active | active | |
| inspect | inspect.scan.depcruiser.layer-boundary | draft | draft | |
| inspect | inspect.scan.depcruiser.module-dependency | draft | draft | |
| inspect | inspect.scan.ironnest.dependency-injection | draft | draft | |
| inspect | inspect.scan.internal.enum-usage | draft | draft | |
| inspect | inspect.scan.internal.null-safety | draft | draft | |
| inspect | inspect.scan.internal.strict-mode | draft | draft | |
| inspect | inspect.scan.internal.type-safety | draft | draft | |
| security | security.scan.semgrep.sql-injection | active | active | |
| security | security.scan.gitleaks.hardcoded-key | draft | draft | |
| security | security.scan.semgrep.command-injection | draft | **active** | ★漂移 |
| security | security.scan.semgrep.csrf | draft | draft | |
| security | security.scan.semgrep.path-traversal | draft | **active** | ★漂移 |
| security | security.scan.semgrep.xss | draft | **active** | ★漂移 |
| security | security.scan.malware.backdoor | draft | draft | |
| security | security.scan.malware.reverse-shell | draft | draft | |
| security | security.scan.malware.supply-chain | trial | **draft** | ★漂移 |
| security | security.scan.garbage.dead-code | draft | draft | |
| security | security.scan.garbage.duplicate-code | draft | draft | |
| security | security.scan.garbage.unused-dependency | draft | draft | |
| security | security.scan.garbage.unused-file | draft | draft | |
| sentinel | sentinel.alert.internal.p1-critical | active | active | |
| sentinel | sentinel.alert.internal.deduplication | active | active | |
| sentinel | sentinel.alert.internal.p2-high | draft | draft | |
| sentinel | sentinel.alert.internal.rollback | draft | draft | |
| sentinel | sentinel.alert.external.runtime-anomaly | trial | trial | |
| evolve | evolve.score.official.dimension-weight | active | active | |
| evolve | evolve.suggest.internal.experience-match | active | active | |
| evolve | evolve.calibrate.internal.false-positive | active | active | |
| evolve | evolve.score.official.grade-boundary | draft | draft | |
| evolve | evolve.score.internal.trend-analysis | draft | draft | |
| evolve | evolve.suggest.internal.fix-generation | draft | draft | |
| evolve | evolve.calibrate.internal.rule-upgrade | draft | draft | |
| evolve | evolve.calibrate.internal.rule-deprecation | draft | draft | |

**统计**：active 12 / draft 27 / trial 4 / deprecated 0（实体，43 = 12+27+4）

> ⚠️ 索引漂移含义：`_registry.yml` 声称 command-injection / path-traversal / xss 已 active，**实际实体是 draft 未执行**——这是体检"带病满分"的机制之一（索引与实体脱节，索引误导排查方向）。

---

## 二、必激活清单（9 条，来自方案 §4.1 P0-1）

### A. security/scan/vulnerability（6 条中 5 条 draft，全激活）

| # | 规则 id | 当前 | 决策 | 工具 | 规则体 | 理由 |
|---|---|---|---|---|---|---|
| 1 | `security.scan.gitleaks.hardcoded-key` | draft | **激活** | gitleaks（已注册）| 无独立规则体（走 gitleaks 内置）| P0 验收四类问题之一（密钥）；SOP 链路密钥检测唯一执行者；fixture 的 `ghp_`/`sk_live_`/`AKIA1234...` 依赖其检出 |
| 2 | `security.scan.semgrep.command-injection` | draft | **激活** | semgrep（已注册）| 内联 8 条 pattern（`toolConfig.rules`）| 方案指定必激活；content-interpreter 透传 `toolConfig` → `semgrep-rule-writer` 写内联 YAML → 免补体，见 §四 D1 终决 |
| 3 | `security.scan.semgrep.csrf` | draft | **激活** | semgrep | 内联 4 条 pattern（`toolConfig.rules`）| 同上 |
| 4 | `security.scan.semgrep.path-traversal` | draft | **激活** | semgrep | 内联 6 条 pattern（`toolConfig.rules`）| 同上 |
| 5 | `security.scan.semgrep.xss` | draft | **激活** | semgrep | 内联 5 条 pattern（`toolConfig.rules`）| 同上 |

### B. inspect/scan/typescript（4 条 draft，保留 draft，D3 新建 tsc 规则承接）

| # | 规则 id | 当前 | 决策 | 工具声明 | 适配器现状 | 理由 |
|---|---|---|---|---|---|---|
| 6 | `inspect.scan.internal.strict-mode` | draft | **保留 draft** | `tsc-config-validator` | **不存在该工具适配器** | 见 §四 D2 终决：激活即空转（`dispatch-evaluators:193` 未注册工具→静默跳过），D3 新建 `tsc` 规则承接 |
| 7 | `inspect.scan.internal.type-safety` | draft | **保留 draft** | `custom-ast-scanner` | **不存在** | 同上 D2 |
| 8 | `inspect.scan.internal.null-safety` | draft | **保留 draft** | `custom-ast-scanner` | **不存在** | 同上 D2 |
| 9 | `inspect.scan.internal.enum-usage` | draft | **保留 draft** | `custom-ast-scanner` | **不存在** | 同上 D2 |

### C. 激活附带项

| 项 | 内容 | 决策 | 理由 |
|---|---|---|---|
| C1 | `_registry.yml` 索引漂移修复 | **需修复** | 4 处状态漂移（command-injection/path-traversal/xss 激活后与实体 active 同步；supply-chain 索引 draft→trial 对齐实体）+ 2 处文件路径漂移（xss→`xss.yml`、csrf→`csrf.yml`）+ 新增 type-error-check 条目。与激活一并执行 |
| C2 | 新规则承接真 tsc（P0-3） | **需新建** | `TypeScriptAdapter`（tool id=`tsc`）已在 `pipeline-runner.ts:65` 注册，但 **43 条规则中无一条声明 `tool: tsc`**——真 tsc 检查从未被规则触发。见 §四 D3 终决 |

---

## 三、保留清单（18 条 draft + 1 条 trial = 19 行）

> 归类说明：体验-match 为 active（已激活）不在此表；下表 19 行 = 18 条保留 draft + supply-chain（实体 trial，需修复索引漂移）。9 条"必激活 draft"见 §二，不重复列出。

| 域 | 规则 id | 保留理由 |
|---|---|---|
| guard | guard.block.external.branch-protection | 门禁域（CI 分支保护），P0 范围不含 guard；且 guard 域执行链路未在本次范围内 |
| guard | guard.block.depcruiser.architecture | 门禁域架构边界拦截；与 P1a 依赖检查归口设计（依赖管家）相关，P0 不激活 |
| inspect | inspect.scan.depcruiser.layer-boundary | 架构层边界检查；`dep-cruiser` 适配器已注册但规则 checker 配置未就绪（rules 集为空），激活即空转 |
| inspect | inspect.scan.depcruiser.module-dependency | 同上 |
| inspect | inspect.scan.ironnest.dependency-injection | NestJS DI 检查；无现成 checker 实现，需先开发后再激活 |
| security | security.scan.malware.backdoor | 病毒查杀域；无规则体、无现成扫描能力，激活空转；且 P1a 调度归属核对确认其执行地后另行处理 |
| security | security.scan.malware.reverse-shell | 同上 |
| security | security.scan.malware.supply-chain | 病毒查杀域；无规则体、无现成扫描能力，激活空转；且 P1a 调度归属核对确认其执行地后另行处理（实体 trial，索引误标 draft，见 C1） |
| security | security.scan.garbage.dead-code | 垃圾清理域；执行地应为垃圾清理分类页（P1a 归口核对项），P0 不激活 |
| security | security.scan.garbage.duplicate-code | 同上 |
| security | security.scan.garbage.unused-dependency | 同上 |
| security | security.scan.garbage.unused-file | 同上 |
| sentinel | sentinel.alert.internal.p2-high | 哨兵域告警策略；非体检/巡检执行链路，不受 P0 影响 |
| sentinel | sentinel.alert.internal.rollback | 同上 |
| evolve | evolve.score.official.grade-boundary | 演进域评分校准；非执行链路（scoring 代码已实现，规则为知识库副本），不激活 |
| evolve | evolve.score.internal.trend-analysis | 同上 |
| evolve | evolve.suggest.internal.fix-generation | 演进域建议生成；非执行链路 |
| evolve | evolve.calibrate.internal.rule-upgrade | 演进域校准；非执行链路 |
| evolve | evolve.calibrate.internal.rule-deprecation | 同上 |

**账目校验**：draft 27 = 必激活 9（hardcoded-key、command-injection、csrf、path-traversal、xss、strict-mode、type-safety、null-safety、enum-usage）+ 保留 18（guard 2 + inspect 3 + security 6 + sentinel 2 + evolve 5）；security 保留 6 = garbage 4 + malware 2（backdoor、reverse-shell；supply-chain 不计入 draft）。与 §一 全表一致。

---

## 四、待人工确认的决策点

### D1 — semgrep 漏洞规则（command-injection / csrf / path-traversal / xss）✅ 已决
~~原判"空壳"已修正~~。实际情况：
- `check.semgrepRules` 确为空；**但** `check.toolConfig.rules` 携带真实 semgrep 模式（command-injection 8 / csrf 4 / path-traversal 6 / xss 5）
- `content-interpreter.ts:60-86`：`check.toolConfig` 逐字透传至 `toolConfig`；`check.semgrepRules` 仅在 `toolConfig.rules` 缺失时合并
- 派发 `tool-dispatch`，tool=`check.tool`（semgrep），toolConfig 含 rules
- `semgrep-rule-writer` 读 `options.config?.rules` → 内联 YAML
- `semgrep-adapter` `checkConfigAvailability`：hasInlineRules=true → config 缺失不阻断
- **残余风险（已实证）**：`extraCheck`/`context`/`requireOneOf` 等非 semgrep 标准字段在写入内联 YAML 时被 writer 忽略（仅读 `id/severity/message/pattern/patterns/patternEither/patternNot/patternRegex/metavariableRegex/languages`），不产生无效 YAML —— 实扫已验证，见 §六 P0-2b
- **残余风险（已知局限）**：semgrep 1.172.0 无法解析 TS 装饰器（`@Post("x")` → "Syntax error ... was unexpected"，文件部分解析），csrf 的 decorator pattern 验证通过但永不命中（不崩溃、无误报）

**终决：直接激活（status draft→active），免补规则体。**

### D2 — inspect TS 规则的工具不存在（strict-mode / type-safety / null-safety / enum-usage）✅ 已决
现状：4 条规则声明 `tool: tsc-config-validator` 或 `tool: custom-ast-scanner`，**代码中无这两个适配器**；已注册的适配器只有 eslint / gitleaks / dep-cruiser / jscpd / ts-prune / semgrep / depcheck / **tsc** / prettier / commit-lint / npm-audit / sonarway / trivy。

**终决：全部保留 draft（不激活）。** 理由：
- `dispatch-evaluators.ts:193`：未注册工具→静默跳过（不报错、不空转、不占位）
- 激活后规则将被 Sisyphus 读取→dispatch→无适配器→跳过→等效于 draft，无增益
- D3 新建 `type-error-check`（`tool: tsc`）已覆盖 TS 类型检查需求，是更强的承接

### D3 — 真 tsc 规则（P0-3 核心）✅ 已决
现状：`TypeScriptAdapter`（解析 tsc stderr，含 `parseTscDiagnostics` 纯函数）已注册但**无规则引用**。
- `TypeScriptAdapter` meta.id=`tsc`，registered at `pipeline-runner.ts:65`
- `options.config?.category ?? 'quality'`，`options.timeout ?? 120000`

**终决：① 新建规则 `inspect.scan.typescript.type-error-check`（`check.tool: tsc`，新增文件，符合"只许新增"红线）**
- 不触碰既有规则；验收口径干净（TS2322 由专用规则承担）
- `type-consistency` 的 semgrep 模式检查保留原语义（`check.rules` 内联，不依赖 `check.tool`）
- 新规则 metadata.status: `active`；`check.tool: tsc`；模板参照 `sql-injection.yml`（active 含 toolConfig 结构）+ `type-consistency.yml`（governance/conditions 格式）
- 新规则 id：`inspect.scan.typescript.type-error-check`
- `_registry.yml` 新增对应索引条目（status active）

### D4 — 激活的验收对应（fixture 四类问题 ↔ 规则归属）
| fixture 问题 | 检出者 | 状态 |
|---|---|---|
| 假密钥（ghp_/sk_live_/AKIA）| gitleaks.hardcoded-key（激活）| 待 D1 后生效 |
| a↔b 循环依赖 | depcruiser.circular-dependency | 已 active |
| 2 处 TS2322 | 真 tsc 规则（新建，D3）| 待 D3 |
| 未使用变量 | eslint（guard 域，归 eslint-error / inspect 的 eslint 适配器）| 已 active |

---

## 五、激活执行步骤（人工确认后）

1. 依据 D1-D3 决策修正规则文件（新增/修改，严格限于方所列文件）
2. 同步修复 `_registry.yml` 4 条索引漂移（C1）
3. 重跑 `pnpm --filter @zh/inspect run test` 与 `pnpm --filter zhshield-cli run test`
4. 按复验 skill `zhshield-inspect-verify` 执行 fixture 四类问题检出回归
5. 通过后回填《体检分类改造方案 v1.2》§九 执行账本 P0-1 状态

---

## 六、P0-2b 执行账本：semgrep 引擎 YAML 引号缺陷修复（2026-09-11）

> 本节记录 D1 激活后首轮实扫暴露的**引擎缺陷**及修复闭环。用户已通过决策确认"修引擎 writer（推荐+改 xss）"跨过"只许新增"红线，改动严格限于下方列出的文件。

### 6.1 根因（bisect 实证）

- **症状**：4 条 vuln 规则（command-injection / csrf / path-traversal / xss）在实扫中全部 `status: "error"`，issueCount=0；`sql-injection` 通过
- **根因**：`packages/inspect/src/adapters/semgrep-rule-writer.ts` 的 `buildRuleYaml` 以**未加引号**的 YAML 标量输出 `message: ${r.message}` 与回退 `Semgrep: ${r.id}`（L85 `r.message || \`Semgrep: ${r.id || \`rule-${i}\`}\``）
  - `message` 中含 `: `（冒号+空格）→ semgrep 报 `Invalid YAML file ...: mapping values are not allowed here`（exit 7）
  - sql-injection 幸存纯属侥幸（其 message 无 `: `）
- **关键坑**：CLI 经 `@zh/inspect` 的 **package.json `exports` → `dist/index.js`** 解析，落的是编译产物；只改 `src/` 不重建 `dist/`，实扫仍走旧代码（bisect 脚本直引 `src/` 时正常，实扫却失败，曾误判为规则内容问题）。**修复后必须 `pnpm build` 重建 dist**

### 6.2 修复内容（grep 实证 6 处）

`semgrep-rule-writer.ts`：所有字符串标量改 `JSON.stringify` 包裹（形成可解析双引号标量）：
1. `id`（L99）
2. `severity`（L101）
3. `message`（L102）
4. 嵌套 `patterns[].patternRegex`（L141）
5. `metavariable`（L145）
6. `regex`（L146）+ 顶层 `patternRegex`（L153）+ appendMetavariableRegex `regex`（L193，同一缺陷，一并修复）

另 **xss.yml 激活后有 4 条 pattern 在 semgrep 1.172.0 无法解析**，逐一替换（cand 实证）：

| pattern 原写 | 问题 | 修复（已 --validate 通过）| 实证 |
|---|---|---|---|
| `dangerouslySetInnerHTML={{...}}` | typescript 语法错误 | `<$EL dangerouslySetInnerHTML={{...}} />` | ✓ |
| `{{{$VAR}}}` | HTML 解析错误 | `pattern-regex: \{\{\{[^}]*\}\}\}` + `language: [generic]` | 3 findings |
| `href="javascript:$VAR"` | 裸属性非法 | `pattern-regex: href\s*=\s*["']\s*javascript:` + `language: [generic]` | 3 findings |
| `eval($VAR)` | 合法 | 保留 | ✓ |

`command-injection.yml`：`subprocess.*(cmd, shell=True)`（Python 通配触发了 semgrep 报错）→ `subprocess.$FUNC($ARGS, shell=True)`。`csrf.yml`：`@(Post|Put|Patch|Delete)($PATH)` 单一 union pattern 无法解析 → `pattern-either` 展开为 4 条独立 decorator pattern。

### 6.3 验证结果（全绿）

- `semgrep --validate`（真实 semgrep 1.172.0）：command-injection 8 / csrf 4 / path-traversal 6 / xss 5 规则全部 valid
- 验收重跑（`tsx packages/cli/src/index.ts inspect --dir <fixture> --format json --report`）：**4 issues（循环依赖 1 + TS2322×2 + 硬编码密钥 1）/ score 60 / C / exit 0**；4 条 semgrep 规则全部 status=passed、0 issues（vuln 样本不在 fixture，检出 0 属预期，规则本身可正常执行）
- 单测：@zh/inspect **142 passed**（19 files）+ zhshield-cli **9 passed**；semgrep-adapter.test.ts 2 处断言由锁定旧格式改为锁定新引号格式
- fixture `.semgrep/` 残留 inline yml 已清理

### 6.4 遗留/已知

- semgrep 1.172.0 不支持 TS 装饰器解析 → csrf decorator pattern 永不命中（验证通过但无检出能力），如需命中需换 semgrep pro/deepsemgrep 语义或改 generic pattern，暂不影响 P0 验收
- 根因涉及 `dist` 重建依赖，属于工程陷阱；本节已记录，避免后续仅改 src 不重建的误区

---

*草拟：Sisyphus（AI 执行者）· 2026-09-11 · 状态：**已由执行者全权确认**（用户委托 "一切你来决定"），D1/D2/D3/C1 终决，可直接执行*