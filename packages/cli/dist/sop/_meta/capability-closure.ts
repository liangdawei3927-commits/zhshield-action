/**
 * 检测能力闭环审计（Capability Closure Audit）
 *
 * ## 要解决什么
 *
 * 项目里长期并存四张「声明表」，它们各自正确、彼此独立：
 *   · `TOOL_IDS` / `TOOL_CAPABILITIES`（@zh/shared）——工具与规则族的归属
 *   · `OWNERSHIP_CLAIMS`（@zh/shared）——issue 归属哪个域
 *   · `INSPECT_SCOPE_DOMAINS`（@zh/shared）——SOP 引擎会求值哪些域
 *   · 内置 SOP 规则模板（presets/sop-templates）——每个域声明自己要查什么
 *
 * 但**没有任何一处回答最关键的那个问题**：
 *   「用户点下『安全中心』按钮时，到底有哪些检测项会真的执行？」
 *
 * 2026-11-02 实测出的断裂（同一份夹具、同一台机器）：
 *   · CLI `inspect --sop` → `security.scan.semgrep.sql-injection` **检出 1 条**（src.ts:7）
 *   · 桌面安全中心 `runDomain('security')` → **0 检出**，且 `status='ok'`、`degraded=undefined`
 *
 * 根因不是「规则没写」，而是**两条入口走的是两套不同的求值路径**：
 *   · SOP 路径：`runSopInspect({domains:['inspect']})` → `@zh/inspect` 的 SemgrepAdapter
 *     （支持 `config.rules` 内联规则 + kernel 资产路径解析 + asar 解包改写）
 *   · 桌面安全页路径：`runDomain('security')` → `SecurityEngine` → `@zh/security` 的
 *     SemgrepAdapter（只认 `--config <目录>`，**不读 `config.rules` 内联规则**）
 *
 * 于是那 7 条 active semgrep 规则（含 sql-injection / xss / command-injection / csrf）
 * 在桌面端一次都不会被求值 —— 它们唯一的载体就是 `toolConfig.rules` 内联 pattern。
 *
 * ## 本模块做什么
 *
 * 提供**一个纯函数**，把「声明」与「实际会执行」放在同一张表上比对，产出：
 *   · 每个域**实际生效**的检测项（规则 id + 工具 + 执行路径）
 *   · 每个域**声明了但不会执行**的检测项，以及**为什么**（断链原因）
 *
 * 它是**审计**，不是修复：它把断链变成可 CI 门禁的事实，让「宣称 vs 实际」无法再悄悄漂移。
 * 修复是另一件事（本模块的输出即修复清单）。
 *
 * ## 边界（诚实声明）
 *
 * 本模块是**声明层**审计，回答「按当前装配，这条规则会被求值吗」；
 * 它**不**回答「这次运行真的检出东西了吗」——后者由运行时账本（DomainRunLedger）
 * 与各域报告的 `skipped[]` / `degraded` 回答。两层职责不同，不可互相替代。
 *
 * 判定完全基于代码里的**单一事实源**，不硬编码任何规则 id：
 *   · 域是否会被 SOP 引擎求值 → `INSPECT_SCOPE_DOMAINS`（@zh/shared）
 *   · 规则是否 active → `SopRule.status === 'active'`
 *   · content 是否可解释 → `ContentInterpreter`
 *   · 声明的工具是否有适配器 → `TOOL_IDS`（@zh/shared）
 *   · 某域走哪条执行路径 → `DOMAIN_EXECUTION_PATHS`（本模块，见下）
 */

import { INSPECT_SCOPE_DOMAINS, TOOL_IDS } from '@zh/shared';
import type { DomainId } from '@zh/shared';
import type { SopRule } from './sop-types';
import { ContentInterpreter } from './content-interpreter';
import type { ContentInstruction } from './rule-evaluation';
import { SOP_SERVED_DOMAINS } from './rule-wiring';

/**
 * 一个域的**实际执行路径**。
 *
 * 这是本模块的核心抽象：同一个规则，在不同域可能走完全不同的通道。
 * 桌面安全页与 CLI 巡检的差别就落在这里 —— 不是规则内容不同，是路径不同。
 */
export type DomainExecutionPath =
  /** SOP 规则引擎求值（`runSopInspect({domains:[...]})`）：走 @zh/inspect 的适配器族 */
  | 'sop-rule-engine'
  /** 域专属执行器（`@zh/pipeline` 的 domain executors）：走该域自己的引擎 */
  | 'domain-executor'
  /** 运行时域（持续监控 / 定时任务）：不参与静态扫描，无 SOP 求值入口 */
  | 'runtime-only'
  /** 纯判定域：只读其它域结论，不执行任何扫描器 */
  | 'conclusion-only';

/**
 * 各域的执行路径（单一事实源）。
 *
 * 与代码的对应关系（改动任一侧必须同步改这里，否则审计结果与实际行为漂移）：
 *   · `sop-rule-engine`  ← `packages/pipeline/src/domains/executors.ts`
 *     `runInspectDomain` → `runSopInspect({domains:['inspect']})`
 *     `runGarbageDomain`  → `runSopInspect({domains:['garbage']})`
 *   · `domain-executor`   ← `runSecurityDomain` / `runDepsDomain` / `runPerformanceDomain`
 *     / `runRefactorDomain`
 *   · `conclusion-only`   ← `runGuardDomain`（只读域快照结论，不启任何工具）
 *   · `runtime-only`      ← `RUNTIME_ONLY_DOMAINS`（sentinel / backup / reports）
 *
 * **注意**：`security` 域曾因走 `domain-executor` 而与 CLI 结论相反
 * （2026-11-02 实测：CLI 检出 SQL 注入、桌面端 0 检出且 status=ok）。
 * 修复后它走 `sop-rule-engine` —— 变更本表必须同步变更
 * `packages/pipeline/src/domains/executors.ts` 的 `runSecurityDomain`，
 * 否则审计结果会与实际行为再次漂移。
 */
export const DOMAIN_EXECUTION_PATHS: Readonly<Record<DomainId, DomainExecutionPath>> = {
  inspect: 'sop-rule-engine',
  guard: 'conclusion-only',
  // security 域现在**同时**跑两条通道（2026-11-02 修复）：
  //   · SOP 规则通道 → `runSopInspect({domains:['security']})`（@zh/inspect 适配器族，
  //     支持内联 rules —— 那 7 条 semgrep 规则的唯一载体）
  //   · 启发式通道   → `SecurityEngine`（恶意代码正则 + 注入指令 taint）
  // 两条通道的结论在 `runSecurityDomain` 里合并去重后产出最终报告。
  // 故 security 归为 `sop-rule-engine` —— 它的 SOP 规则**确实会被求值**。
  security: 'sop-rule-engine',
  deps: 'domain-executor',
  garbage: 'sop-rule-engine',
  performance: 'domain-executor',
  techdebt: 'domain-executor',
  refactor: 'domain-executor',
  sentinel: 'runtime-only',
  backup: 'runtime-only',
  reports: 'runtime-only',
};

/** 断链原因：为什么一条「声明了」的检测项不会真的执行 */
export type ClosureBreakReason =
  /** 规则不是 active 状态（draft / trial / deprecated）→ 引擎按状态过滤，永不求值 */
  | 'rule-not-active'
  /** 规则所在域没有 SOP 求值入口（如 evolve / sentinel） */
  | 'domain-not-served'
  /** content 解释不成任何可执行指令 */
  | 'unresolved-content'
  /** 声明的工具不在 TOOL_IDS 内（伪工具） */
  | 'tool-not-registered'
  /** 规则是 active 且可执行，但该域的执行路径不经过 SOP 规则引擎 → 规则不会被求值 */
  | 'path-bypasses-sop-engine';

/** 一条检测项的闭环状态 */
export interface CapabilityItem {
  /** 规则 id */
  ruleId: string;
  /** 规则所在域 */
  domain: DomainId;
  /** 规则名（人类可读） */
  name: string;
  /** 规则声明的工具（无 tool-dispatch 时为 null，如 forbidden-regex 内联求值） */
  tool: string | null;
  /** 规则是否 active */
  active: boolean;
  /** 该域的执行路径 */
  path: DomainExecutionPath;
  /** 是否真的会被求值 */
  effective: boolean;
  /** 不会执行时的断链原因 */
  breakReason?: ClosureBreakReason;
  /** 人类可读的断链说明 */
  detail?: string;
}

/** 单域的闭环审计结果 */
export interface DomainClosure {
  domain: DomainId;
  path: DomainExecutionPath;
  /** 该域声明的全部规则（含非 active） */
  declared: number;
  /** 该域 active 且真的会被求值的规则数 */
  effective: number;
  /** 该域 active 但不会执行的规则数 */
  broken: number;
  items: CapabilityItem[];
}

/** 全局闭环审计结果 */
export interface CapabilityClosureReport {
  /** 全部声明的规则数 */
  declaredTotal: number;
  /** active 规则数 */
  activeTotal: number;
  /** 真正会被求值的规则数 */
  effectiveTotal: number;
  /** active 但不会执行的规则数 */
  brokenTotal: number;
  domains: DomainClosure[];
  /** 全部断链明细（按域 + 规则 id 排序） */
  breaks: CapabilityItem[];
}

/**
 * 域的规则是否**会被 SOP 引擎求值**（不管用什么方式）。
 *
 * 口径直接取 `SOP_SERVED_DOMAINS`（= guard + INSPECT_SCOPE_DOMAINS），
 * 与 `rule-wiring.ts` 的审计口径同源：
 *   · `guard` 由 `SopRuleEngine.runGuard` 求值（纯判定：只读供应商域结论，不启工具）
 *   · `inspect` / `security` / `garbage` 由 `SopRuleEngine.runInspect` 求值
 *
 * 判据区别（这是本模块与 rule-wiring 的关键差异）：
 *   · rule-wiring 问「这条规则能不能被求值」——只看规则自身是否健康
 *   · 本模块问「这条规则**在产品里**会不会被求值」——还要看所属域的执行路径
 */
export function isSopServedDomain(domain: DomainId): boolean {
  return (SOP_SERVED_DOMAINS as readonly string[]).includes(domain);
}

/** 从规则 content 里取声明的工具（只认 tool-dispatch；其余指令类型无工具） */
function declaredTool(instruction: ContentInstruction): string | null {
  if (instruction.type !== 'tool-dispatch') return null;
  const tool = instruction.tool.trim();
  return tool === '' ? null : tool;
}

/**
 * 判定单条规则的闭环状态。
 *
 * 判定顺序固定（先排除「本来就不会跑」的，再看路径）：
 *   1. 非 active → `rule-not-active`（这是正常状态，不是断链缺陷）
 *   2. 域不在 SOP 服务域 → `domain-not-served`
 *   3. content 不可解释 → `unresolved-content`
 *   4. 工具未注册 → `tool-not-registered`
 *   5. 域走域专属执行器 → `path-bypasses-sop-engine`（**核心断裂**）
 *   6. 否则 → effective
 */
export function classifyCapability(
  rule: SopRule,
  instruction: ContentInstruction,
  path: DomainExecutionPath = DOMAIN_EXECUTION_PATHS[rule.domain as DomainId] ?? 'domain-executor',
): CapabilityItem {
  const tool = declaredTool(instruction);
  const base = {
    ruleId: rule.id,
    domain: rule.domain as DomainId,
    name: rule.name,
    tool,
    active: rule.status === 'active',
    path,
  };

  if (rule.status !== 'active') {
    return {
      ...base,
      effective: false,
      breakReason: 'rule-not-active',
      detail: `规则状态为 ${rule.status}，引擎按 active 过滤，该规则不会被求值`,
    };
  }

  if (!isSopServedDomain(rule.domain as DomainId)) {
    return {
      ...base,
      effective: false,
      breakReason: 'domain-not-served',
      detail: `治理域 ${rule.domain} 不在 SOP 求值域集（${INSPECT_SCOPE_DOMAINS.join('/')}）内`,
    };
  }

  if (instruction.type === 'unresolved') {
    return {
      ...base,
      effective: false,
      breakReason: 'unresolved-content',
      detail: `规则内容无法解释为可执行指令：${instruction.reason}`,
    };
  }

  if (tool !== null && !(TOOL_IDS as readonly string[]).includes(tool)) {
    return {
      ...base,
      effective: false,
      breakReason: 'tool-not-registered',
      detail: `工具 "${tool}" 不在 TOOL_IDS 内，没有对应适配器，规则只会落 skipped`,
    };
  }

  // 到这里说明规则本身完全健康（active + 域被服务 + content 可解释 + 工具有效）。
  // 剩下唯一的断链可能：**所属域的执行路径根本不经过 SOP 规则引擎**，
  // 于是这条规则永远不会被求值 —— 这是架构级断裂，
  // 也是 2026-11-02 实测到的「CLI 检出、桌面端 0 检出」的直接成因。
  //
  // `conclusion-only`（门禁域）不算断裂：门禁按设计就是纯判定域，
  // 它的规则读供应商域结论判 pass/fail，规则本身**确实会被求值**，
  // 只是不启任何工具。把它算成断裂是误报。
  if (path === 'domain-executor' || path === 'runtime-only') {
    return {
      ...base,
      effective: false,
      breakReason: 'path-bypasses-sop-engine',
      detail:
        `域 ${rule.domain} 走「${path}」路径，不经过 SOP 规则引擎；` +
        `该规则的唯一检测载体（内联 pattern / 资产 config）不会被求值`,
    };
  }

  return { ...base, effective: true };
}

/**
 * 审计一批规则的闭环状态。
 *
 * @param rules 待审计规则（内置 presets + 云端同步缓存，或注册表全量）
 * @param interpreter 内容解释器（单测可注入；缺省新建，无状态、可共享）
 */
export function auditCapabilityClosure(
  rules: readonly SopRule[],
  interpreter: ContentInterpreter = new ContentInterpreter(),
): CapabilityClosureReport {
  const items = rules.map((rule) => classifyCapability(rule, interpreter.interpret(rule)));

  const domainIds = [...new Set(items.map((i) => i.domain))].sort();
  const domains: DomainClosure[] = domainIds.map((domain) => {
    const domainItems = items.filter((i) => i.domain === domain);
    return {
      domain,
      path: domainItems[0]?.path ?? 'domain-executor',
      declared: domainItems.length,
      effective: domainItems.filter((i) => i.effective).length,
      broken: domainItems.filter((i) => i.active && !i.effective).length,
      items: domainItems,
    };
  });

  const breaks = items
    .filter((i) => i.active && !i.effective)
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.ruleId.localeCompare(b.ruleId));

  return {
    declaredTotal: items.length,
    activeTotal: items.filter((i) => i.active).length,
    effectiveTotal: items.filter((i) => i.effective).length,
    brokenTotal: breaks.length,
    domains,
    breaks,
  };
}

/**
 * 判定一份闭环审计结果是否可以放行（CI 门禁判据）。
 *
 * 门禁只拦「active 但永远不会执行」的规则 —— 那是**事实与宣称不符**，
 * 用户点按钮得不到结果，而报告里看不出任何异常。
 *
 * `rule-not-active`（draft / trial）**不拦**：那是规则的正常生命周期状态，
 * 尚未激活的规则本来就不该生效。
 */
export function isClosureAcceptable(report: CapabilityClosureReport): boolean {
  return report.brokenTotal === 0;
}
