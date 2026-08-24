# ZHCodeShield × Simula 对齐加固 — 修正后落地计划

> 本计划基于一次真实架构核查（explore 子代理对 `zhiyan-codeshield` 全仓扫描）重写。
> 原始 6 方案方向正确，但文字建立在"想象中的简化版代码库"上，至少 6 处前提与真实架构不符。
> 本计划纠正这些前提，并按真实依赖关系重排优先级。
>
> 全局质量红线（每个方案必须遵守）：**可测试 / 可验证 / 可回归 / 可运行**。
> 验收标准一律用 `vitest` 具体断言表达，CI 跑 `turbo run test` 必须全绿才算完成。

---

## 0. 核心纠正（来自架构核查，必须先在 C 闸门确认）

| # | 原始前提（错误） | 真实架构 | 影响 |
|---|---|---|---|
| C1 | `SopEngine.resolveAction()` 存在，severity/阻断写死在 YAML | 引擎是 `SopRuleEngine`（`packages/kernel/src/runner.ts:42`），核心 `evaluateRules()`；"谁执行"由 `ContentInterpreter.interpret()`（`packages/kernel/src/sop/_meta/content-interpreter.ts`）按 content 形状推断。无 `resolveAction` | 方案一的"在 resolveAction 前插 resolveSeverity 钩子"落错点 |
| C2 | severity 决定阻断策略 | 阻断是**状态驱动**：`RuleEngineReport.ok = failed===0 && errors===0`（`runner.ts` 注释：*"SOP 规则的 blocking 由触发方决定，这里只汇报数字"*）；`guard/src/engine.ts` 里 `blocking: ev.status==='failed'`，severity 仅当报告标签。任何评估失败即阻断，与 severity 无关 | 方案一如果只是"升级 severity"只会改报告标签，**不改变行为**；必须同时把 gate 改成 severity 感知才有价值 |
| C3 | ToolAdapter 调用无审计链 | `AuditLogger`（`packages/shared/src/audit-logger.ts`）已存在，inspect 执行器与 security 引擎两个调用点已记 `tool-executed` + 发 `tool:executed` 事件。缺口仅在 **kernel SOP dispatch（`dispatch-evaluators.ts:186`）未记**，且 scan() 散在 **3 个包 3 个调用点** | 方案二被高估：是"补齐+统一"不是"从零建" |
| C4 | `@zh/sentinel` 已有 `baselineScore`/`recentWarnings` 监控数据 | sentinel 只有 monitors/events（`SentinelEvent` 流 + `sentinel_events` 表），无健康分。健康分在 **`@zh/scoring`**（`HealthScore`/`DimensionScore`，存 `scores` 表） | 方案二要对接的"监控数据"应取自 `scoring` + `sentinel_events` 历史 |
| C5 | 需"新增 InjectionGuard" / "新增 CrossValidator" | 注入检测已有 semgrep 规则包 `packages/kernel/src/sop/tool-packs/semgrep/rules/backdoor.yaml`（sql/command/xss/eval 等）；`CrossValidator` 已有 `GrypeCrossValidator`（`packages/security/src/cross-validator.ts`，Trivy×Grype 漏洞交叉校验，engine.ts:208 已接） | 方案三/四是"扩展"非"greenfield"，命名会撞 |
| C6 | `scan(options: ScanOptions)` / `isAvailable(): boolean` | 真实：`scan(options: ToolScanOptions)`（`shared/src/types.ts:332`），`isAvailable(): Promise<boolean>`，且 `ToolAdapter` 强制要求 `meta: ToolMeta`（`types.ts:340`） | 方案六接口签名要改；SOP YAML 有**两套 schema**（simple flat 与 metadata/governance/judgment 嵌套），加字段要两处都改 |

---

## 1. 重排后的优先级与依赖（关键架构决策）

原方案把"审计链"和"动态防御"并列 P0。但方案一/四/六**都需要在 scan() 周围插拦截点**，而 scan() 散在 3 个调用点。若各自硬编码会烂。

**正确顺序：把方案二里的 Hook 层提升为地基（F0），其余全部挂它之上。**

```
F0  Hook/Audit 地基（原方案二，升为 P0 地基）
 ├─ F1  动态防御升级（原方案一，依赖 F0 的钩子 + gate 改造）
 ├─ F2  对抗性注入检测（原方案三，扩展 semgrep 包 + 新增注释/.env/markdown Guard）
 ├─ F3  二次校验层（原方案四，改名 RuleConflictResolver，复用现有 CrossValidator 模式）
 ├─ F4  合成对抗测试（原方案五）
 └─ F5  权限边界声明（原方案六，依赖 F0 的装饰器做 scope 校验）
```

执行阶段：
- **阶段 1**：F0（Hook 装饰器 + 审计统一 + kernel dispatch 补记）+ F1（severity 钩子 + gate 改造）
- **阶段 2**：F2（注入检测）+ F3（二次校验）
- **阶段 3**：F5（AccessScope）+ F4（合成测试，作为长期质量保障收尾）

---

## 2. 全局质量门禁（每个方案落地时强制，且作为合入门禁）

每个方案的 PR/提交必须满足以下四条且全部**可执行验证**。命令以 `zhiyan-codeshield` 为根，`turbo` 来自根 `package.json`。

- **可测试（单测）**
  - 每个新逻辑单元（纯函数 / 装饰器 / 评估器）配 `vitest` 单测，放 `packages/<pkg>/src/**/__tests__/`。
  - 拦截点 / 钩子必须配 mock `ToolAdapter` 单测（断言 `before` 返回 null→阻断、`after` 改写生效）。
  - 命令：`pnpm --filter @zh/<pkg> test`（即 `vitest run`）。
- **可验证（端到端行为证明）**
  - 每个方案至少 1 个集成/e2e 用例证明"行为确实改变"，而非只覆盖旧路径。
  - 例（F1）：连续 3 次触发 warning 的规则，第 4 次评估 `effectiveSeverity=high` 且 `guardReport.ok=false` / `report.blockingCount>=1`。
  - 例（F0）：挂计数 hook 的 mock adapter，断言 scan 前后各触发一次；`before` 返回 null 时 `auditLogger` 记 `block`。
- **可回归（基线不被破坏）**
  - 改动不得破坏现有 `turbo run test` 全绿；新增 fixture 进 `packages/*/src/__tests__/fixtures`，**旧用例语义不得删改**（如需变更既有断言，必须先在 C 闸门说明并获确认）。
  - 回归基线策略：以当前 `main` 分支的 `turbo run test` 全绿为 golden baseline；任何方案合并前 CI 必须复跑**全量**测试（不止改动包），防止跨包隐式依赖被破坏——尤其 kernel↔guard↔pipeline 的 gate 链。
- **可运行（构建 + 类型）**
  - `pnpm --filter @zh/<pkg> build` 通过；`pnpm --filter @zh/<pkg> exec tsc --noEmit -p tsconfig.json` 零错误。
  - 严禁 `as any` / `@ts-ignore` / `@ts-expect-error`；类型错误一律正面修复。
  - 全仓类型闸门：`pnpm build`（Turborepo 构建全部包，验证跨包类型契约）。
- **零 Token 原则**：保持现有"不调 LLM"哲学，所有校验用规则/确定性逻辑，不引入任何 AI 模型调用（F0–F5 统一遵守；若某方案确需模型，必须回到 C 闸门重议）。

合并前合入门禁（CI 自动）：`turbo run test` + `turbo run build` + `pnpm lint` 全绿。

---

## 3. 各方案详细（F0–F5）

### F0 — Hook/Audit 地基（P0 地基，原方案二）
**目标**：在 `@zh/shared` 定义 `ToolCallHook` 装饰器，于 3 个 `registerAdapter`/`registerToolAdapter` 入口统一包一层，使所有 scan() 调用经过 before/after 拦截；补齐 kernel dispatch 的审计；统一审计结构。

**真实改动点**：
- `packages/shared/src/types.ts`：新增 `ToolCallHook` 接口（`before(adapter, opts): ToolScanOptions|null`、`after(adapter, result): ToolResult`），新增 `AuditEntry` 类型（对齐现有 `AuditLogEntry`）。
- `packages/shared/src/`：新增 `tool-adapter-decorator.ts` —— `wrapAdapter(adapter: ToolAdapter, hooks: ToolCallHook[]): ToolAdapter`，内部在 `scan()` 前后跑 hooks，null 返回即阻断，记录 `hookModifications`。
- 3 个注册入口包装饰器：`packages/inspect/src/engine.ts:62 registerAdapter`、`packages/security/src/engine.ts:59 registerAdapter`、`packages/kernel/src/runner.ts:106 registerToolAdapter`。
- `packages/kernel/src/runner/dispatch-evaluators.ts:186`：调用 `auditLogger.logToolExecution`（与另两处对齐）。

**验收标准（可测试/可验证/可回归/可运行）**：
- 单测：`wrapAdapter` 在 `before` 返回 null 时 scan 不被调用且记 `block`；`after` 改写 result 生效。
- 回归：现有 inspect/security 审计用例仍绿；`turbo run test` 全绿。
- 运行：`pnpm --filter @zh/shared build` + `tsc` 零错。
- 验证脚本：构造 mock adapter，挂一个计数 hook，断言 scan 前后各触发一次。

### F1 — 动态防御升级（P0，原方案一，依赖 F0）
**目标**：SOP 规则支持 `accumulationPolicy`；在评估时动态计算 effective severity；并把 gate 改为 **severity 感知**（纠正 C2）。

**真实改动点**：
- `packages/kernel/src/sop/_meta/sop-types.ts:71`：`SopRule` 加 `accumulationPolicy?: { window: number; threshold: number; escalateTo: Severity }`；`Severity` 联合保持 `critical|high|medium|low|info`（先修 C6 的 `severity: error` 越界数据）。
- `packages/kernel/src/sop/_meta/sop-loader.ts`：`buildSimple` 与 `buildWithMeta` **两处**都解析 `accumulationPolicy`（纠正 C6 双 schema）。
- `packages/kernel/src/runner.ts`：`evaluateAll`/`evaluateOne` 前插入 `resolveSeverity(rule, ctx)` —— 读近期同 ruleId 评估历史（来自 `scoring` 的 `HealthScore` 维度 + `sentinel_events` 历史，纠正 C4），累积≥threshold 则升 `escalateTo`。
- **gate 改造（核心）**：`guard/src/engine.ts` 的 `evalToCheckResult` + `packages/pipeline/src/sop-pipeline-runner.ts` 的 gate：阻断阈值 `blockingThreshold`（默认 `high`），仅当 `effectiveSeverity >= blockingThreshold` 才 `blocking=true`。
- 数据迁移：现有 YAML `severity: error` 归一化为 `high`（写迁移脚本，进 `packages/kernel/src/sop/` 或文档）。

**验收标准**：
- 单测：`resolveSeverity` 在窗口内同类 warning≥3 次 → 返回 `error`；基线下移 → 全局升一级。
- **端到端验证（关键）**：一条默认 `severity: medium` 且 `accumulationPolicy` 设 3 次的规则，连续 3 次触发 warning 后，第 4 次评估 `effectiveSeverity=high>=blockingThreshold` → guard 报告 `blocking=true`，pipeline `guardReport.ok=false`。**证明 severity 升级真的改变阻断行为（纠正 C2）**。
- 回归：现有"失败即阻断"语义对 high+ 规则不变；低 severity 规则不再误阻断。
- 运行：`tsc` 零错，不破坏 `build`。

### F2 — 对抗性注入检测（P1，原方案三）
**目标**：覆盖 AI 编程工具特有攻击面（恶意注释/依赖脚本/.env 外泄/静音超链接/eval 链）。

**真实改动点**：
- 扩展 `packages/kernel/src/sop/tool-packs/semgrep/rules/backdoor.yaml`（已有 sql/command/xss/eval）—— 新增 `suspicious-comment-instruction`、`dependency-script-injection`、`env-file-exfiltration`、`markdown-hidden-link`（纠正 C5：注入检测已在规则层，不是 greenfield）。
- 新增 `packages/security/src/injection-guard.ts`：处理 semgrep YAML 难覆盖的语义（注释中的 prompt 指令、`.env` 被 git track、`package.json` scripts 可疑 shell）—— 因为 `SecurityEngine` 已有扫描循环（`engine.ts:148`），直接挂为一条扫描管线。
- 对应 SOP 模板放 `packages/kernel/src/sop/security/scan/injection/`，注册到 inspect 适配器列表。

**验收标准**：
- 单测：每条规则对正例 fixture 命中、对反例 fixture 不误报。
- 验证：构造含恶意注释的 `.ts` fixture + 含可疑 `scripts` 的 `package.json` fixture，跑 injection-guard 断言命中。
- 回归：现有 backdoor.yaml 用例仍绿。
- 运行：`vitest run` + `build` 通过。

### F3 — 二次校验层（P1，原方案四，改名 RuleConflictResolver）
**目标**：Scan 结果经规则交叉验证，分离 confirmed / falsePositives，降误报。

**真实改动点**：
- 复用现有 `GrypeCrossValidator` 模式（`packages/security/src/cross-validator.ts` 的 `CrossValidationReport` 类型），新增通用 `RuleConflictResolver`（`packages/security/src/rule-conflict-resolver.ts`）—— 避免与现有 `CrossValidator` 命名撞车（纠正 C5）。
- 挂入 `SecurityEngine.validate` 流程（参考 `engine.ts:208` 现有 crossValidator 接线）。

**验收标准**：
- 单测：注入一组自相矛盾的规则结果，断言 resolver 标记 falsePositive 且不进 Guard 决策。
- 验证：用 F2 的 injection 结果跑 resolver，证明误报下降。
- 回归：现有 GrypeCrossValidator 用例不变。
- 运行：`build` + `tsc` 零错。

### F4 — 合成对抗测试（P2，原方案五）
**目标**：用合成攻击数据让规则"越用越准"，对齐 Simula 真实强项（合成数据引擎）。

**真实改动点**：
- 定义 attack-pattern YAML schema（源：F2 的注入规则 + 未来规则），放 `packages/security/src/__tests__/attack-patterns/`。
- 新增 `packages/security/src/adversarial-test-gen.ts`：读 schema → 生成 fixture → 跑 `__tests__`。
- CI 集成：复用现有 `vitest`；`turbo run test` 含此生成用例。

**验收标准**：
- 单测：生成器对给定 pattern 产出 N 个变体 fixture（local/global diversification）。
- 验证：跑生成用例，断言规则对变体命中率稳定。
- 回归：生成 fixture 不污染手写的固定用例。
- 运行：CI 下 `vitest run` 含生成用例。

### F5 — 权限边界声明（P2，原方案六）
**目标**：ToolAdapter 声明 `accessScope`，越界访问告警（纠正 C6 签名）。

**真实改动点**：
- `packages/shared/src/types.ts`：`ToolAdapter` 加可选 `accessScope?: AccessScope`（含 `readPaths`/`excludePaths`/`sensitivePatterns`）；`ToolScanOptions` 维持。
- 各适配器声明：`packages/inspect/src/adapters/*`（如 gitleaks 仅 `**/*.{env,ts,js,json,yaml,yml}`，排除 `node_modules`）。
- 校验点：在 F0 的 `wrapAdapter.scan` 前后做 scope 校验（纠正"kernel 拦截子进程读文件"不可行——改为**校验 scan 入参 + 对越界声明告警**，不硬拦子进程）。
- `packages/sentinel` 消费越界事件告警（用现有 `SentinelEvent` 流，纠正 C4）。

**验收标准**：
- 单测：声明 scope 的 adapter 收到范围外 targetFiles → 记越界事件且不崩溃。
- 验证：gitleaks 配 scope，传 `node_modules/**` 路径 → sentinel 收到越界告警。
- 回归：无 scope 声明的旧 adapter 行为不变（字段可选）。
- 运行：`build` + `tsc` 零错。

---

## 4. 待 C 闸门确认项（写码前必须拍板）

1. C1/C2：F1 的 gate 语义变更（severity 感知）是否接受"低 severity 规则不再默认阻断"？这改变现有"失败即阻断"行为，需产品确认。
2. C4：F1 的 `baselineScore`/`recentWarnings` 数据源采用 `scoring.HealthScore` + `sentinel_events` 历史，是否认可？
3. C6：现有 `severity: error` 越界 YAML 的归一化策略（批量改 high vs 加兼容映射）？
4. F2/F3 命名与现有 `backdoor.yaml`/`GrypeCrossValidator` 的边界划分？
5. 零 Token 原则是否覆盖全部 F0–F5（不引入任何 LLM 调用）？

---

## 5. 执行顺序（阶段）

- **阶段 1**：F0 → F1（地基 + 最高风险项，先验证 C2 gate 改造）
- **阶段 2**：F2 → F3
- **阶段 3**：F5 → F4

每阶段结束 `turbo run test` 必须全绿，方可进入下一阶段。

---

## TODOs

- [x] 1. F0-1 `@zh/shared` 新增 `ToolCallHook` 接口 + `AuditEntry` 类型（types.ts）
- [x] 2. F0-2 `@zh/shared` 新增 `tool-adapter-decorator.ts`（`wrapAdapter`：scan 前后跑 hooks，before 返回 null 即阻断，记录 hookModifications）
- [x] 3. F0-3 三个注册入口包装饰器：`inspect/src/engine.ts:62`、`security/src/engine.ts:59`、`kernel/src/runner.ts:106`
- [x] 4. F0-4 `kernel/src/runner/dispatch-evaluators.ts:186` 补 `auditLogger.logToolExecution`（对齐另两处）
- [x] 5. F0-5 F0 单测 + 集成测（`wrapAdapter` before=null→阻断；after 改写生效；mock adapter 计数 hook 触发）；`turbo run test` 全绿、`tsc` 零错
- [x] 6. F0-6 F0 验收证据（Manual-QA：mock adapter + 计数 hook 断言 scan 前后各触发一次 + before=null 记 block）
- [x] 7. F1-1 `sop-types.ts:71` 加 `accumulationPolicy?` + `blockingThreshold?`；`Severity` 联合加 `'error'`
- [x] 8. F1-2 `sop-loader.ts` 的 `buildSimple`/`buildWithMeta` 两处解析新字段
- [x] 9. F1-3 新增 `adaptive-severity.ts`（`resolveSeverity` 纯函数，依赖注入 `AdaptiveContext`）+ `runner.ts` 集成（evaluateAll 插入 effectiveRule，浅拷贝不改 registry 原对象）
- [x] 10. F1-4 gate 改造（向后兼容）：`rule-evaluation.ts` 加 `blocking?`；`aggregate` 加 `blockingCount`；`blocking = status==='failed' && rank(severity)>=rank(blockingThreshold)`；pipeline `ok` 保持状态驱动不变；GuardEngine 消费 blocking 做 high+ 阻断/告警
- [x] 11. F1-5 数据迁移：现有 `severity: error` YAML 归一化（加 `'error'` 到联合后自然合法）
- [x] 12. F1-6 F1 单测 + 集成测（3 次同类 warning→escalateTo high；baseline<60 升一级）+ 回归（`turbo run test` 全绿）
- [x] 13. F2-1 扩展 `backdoor.yaml`（suspicious-comment-instruction / dependency-script-injection / env-file-exfiltration / markdown-hidden-link）
- [x] 14. F2-2 新增 `security/src/injection-guard.ts` + 挂入 SecurityEngine 扫描循环（engine.ts:148）
- [x] 15. F2-3 SOP 模板 `kernel/src/sop/security/scan/injection/` + 注册 inspect 适配器
- [x] 16. F2-4 F2 单测 + 验证（恶意注释/.env/scripts fixture 命中）+ 回归
- [x] 17. F3-1 新增 `security/src/rule-conflict-resolver.ts`（复用 CrossValidationReport 模式，改名避撞）
- [x] 18. F3-2 挂入 SecurityEngine.validate（参考 engine.ts:208）
- [x] 19. F3-3 F3 单测（矛盾结果→falsePositive）+ 回归
- [x] 20. F5-1 `ToolAdapter` 加可选 `accessScope?`（types.ts）；各适配器声明
- [x] 21. F5-2 F0 装饰器内做 scope 校验（入参校验+越界告警）；sentinel 消费
- [x] 22. F5-3 F5 单测 + 验证（gitleaks 配 scope 传 node_modules→sentinel 告警）+ 回归
- [x] 23. F4-1 定义 attack-pattern YAML schema + `adversarial-test-gen.ts`
- [x] 24. F4-2 CI 集成（`turbo run test` 含生成用例）；F4 单测 + 验证

## Final Verification Wave
- [ ] F1. 全仓 `turbo run test` 全绿 + `pnpm build` 通过 + `pnpm lint` 零错 + `tsc` 零错（无 as any/@ts-ignore）
