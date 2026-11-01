import { INSPECT_SCOPE_DOMAINS, TOOL_IDS } from '@zh/shared';
import type { SopRule } from './sop-types';
import { ContentInterpreter } from './content-interpreter';
import type { ContentInstruction } from './rule-evaluation';

/**
 * 规则接线审计（《07》§四 O6）。
 *
 * `rules.db`（内置 presets + 云端同步缓存）里存在两类「永远求值不到」的规则：
 *   ① 治理域没有 SOP 求值入口（refactor / sentinel / evolve 走各自的运行时或原生探测器）；
 *   ② content 解释不成任何可执行指令，或声明的工具根本不在 `TOOL_IDS`（伪 tool）。
 *
 * 这些规则**留在注册表里不会产出任何结论**，却会让规则总数与「实际参与判定」的条数失真。
 * 本模块把判定收敛成一处纯函数：加载后即可审计，供调用方标记 `orphan`（或据此下线规则），
 * 而不是等到报告里出现「degraded skipped」才反推。
 *
 * 判定顺序固定为 域 → 内容 → 工具：前者成立时后者不再有意义（域不服务的规则就算工具齐备也跑不到）。
 */

/**
 * SOP 引擎实际求值的治理域：guard + 全量巡检默认域集。
 * 与 `SopRuleEngine.runGuard` / `runInspect` 的过滤口径同源，避免审计表和引擎行为漂移。
 */
export const SOP_SERVED_DOMAINS = ['guard', ...INSPECT_SCOPE_DOMAINS] as const;

/** orphan 原因 */
export type RuleWiringReason =
  | 'domain-not-served'
  | 'unresolved-content'
  | 'tool-missing'
  | 'tool-not-registered';

/** 一条永远求值不到的规则 */
export interface OrphanRule {
  ruleId: string;
  domain: SopRule['domain'];
  action: SopRule['action'];
  status: SopRule['status'];
  reason: RuleWiringReason;
  detail: string;
  /** 仅 tool-dispatch 相关原因携带 */
  tool?: string;
}

/** 一次审计的结果 */
export interface RuleWiringReport {
  total: number;
  wired: number;
  orphans: OrphanRule[];
}

function orphan(rule: SopRule, reason: RuleWiringReason, detail: string, tool?: string): OrphanRule {
  return {
    ruleId: rule.id,
    domain: rule.domain,
    action: rule.action,
    status: rule.status,
    reason,
    detail,
    ...(tool === undefined ? {} : { tool }),
  };
}

/**
 * 判定单条规则是否 orphan；接线正常返回 null。
 *
 * 注：`tool-dispatch` 只校验工具名是否在 `TOOL_IDS`，**不校验运行时是否注册了适配器**。
 * 后者属于环境问题（工具未装 → skipped + degraded，由 C4 处理），不是接线问题；
 * 把它并进 orphan 会让「今天没装 trivy」变成「规则永久下线」的误判。
 */
export function classifyRuleWiring(
  rule: SopRule,
  instruction: ContentInstruction,
): OrphanRule | null {
  if (!(SOP_SERVED_DOMAINS as readonly string[]).includes(rule.domain)) {
    return orphan(
      rule,
      'domain-not-served',
      `治理域 ${rule.domain} 没有 SOP 求值入口（引擎只跑 ${SOP_SERVED_DOMAINS.join('/')}），规则永远不会被求值`,
    );
  }

  if (instruction.type === 'unresolved') {
    return orphan(rule, 'unresolved-content', `content 无任何可执行指令段：${instruction.reason}`);
  }

  if (instruction.type === 'tool-dispatch') {
    if (instruction.tool.trim() === '') {
      return orphan(rule, 'tool-missing', 'check 段声明了 tool 但取值为空，规则无法派发到任何适配器');
    }
    if (!(TOOL_IDS as readonly string[]).includes(instruction.tool)) {
      return orphan(
        rule,
        'tool-not-registered',
        `工具 "${instruction.tool}" 不在 TOOL_IDS 内：核心库没有对应适配器，规则只会落 skipped`,
        instruction.tool,
      );
    }
  }

  return null;
}

/**
 * 审计一批规则的接线状态。
 *
 * @param rules 待审计规则（内置 presets、云端同步缓存或注册表全量）
 * @param interpreter 解释器（单测可注入；缺省新建，无状态、可共享）
 */
export function auditRuleWiring(
  rules: readonly SopRule[],
  interpreter: ContentInterpreter = new ContentInterpreter(),
): RuleWiringReport {
  const orphans: OrphanRule[] = [];
  for (const rule of rules) {
    const found = classifyRuleWiring(rule, interpreter.interpret(rule));
    if (found) orphans.push(found);
  }
  return { total: rules.length, wired: rules.length - orphans.length, orphans };
}
