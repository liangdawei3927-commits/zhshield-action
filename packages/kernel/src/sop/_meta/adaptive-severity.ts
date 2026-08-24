import type { SopRule, Severity } from './sop-types';
import type { EvaluationStatus } from './rule-evaluation';

// ─── severity 秩序表（F1-3 单一事实源）────────────────────
/** 固定升序：'error' 对齐 ESLint/semgrep 的 ERROR 档，位于 medium 与 high 之间。
 *  联合之外的遗留运行时值（如存量数据的 'warning'）按最低秩 -1 处理。 */
export const SEVERITY_RANK: ReadonlyMap<string, number> = new Map<string, number>([
  ['info', 0],
  ['low', 1],
  ['medium', 2],
  ['error', 3],
  ['high', 4],
  ['critical', 5],
]);

/** 与 SEVERITY_RANK 同序的固定升档路径（基线 bump 每次恰好上移一档，封顶 critical） */
const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'medium', 'error', 'high', 'critical'];

/** severity → 秩（未知值返回 -1，保证比较时"不升级"的安全方向） */
export function severityRank(sev: string): number {
  return SEVERITY_RANK.get(sev) ?? -1;
}

// ─── 动态严重级解析 ────────────────────────────────────────

/** 动态严重级解析的外部上下文（依赖注入，保持纯函数可测） */
export interface AdaptiveContext {
  /** 该规则连续未通过（failed/error）的评估次数（由调用方计数器提供） */
  consecutiveFailures?: number;
  /** 项目健康基线分（@zh/scoring 注入；缺省 undefined = 基线升档关闭） */
  healthBaseline?: number;
}

/**
 * resolveSeverity — 纯函数：由规则静态声明 + 外部上下文解析本次评估的有效严重级。
 *
 * 确定性语义（两步固定顺序，无副作用）：
 * 1. 策略升档：存在 accumulationPolicy 且 consecutiveFailures >= (threshold ?? 3)
 *    且 escalateTo 秩严格高于当前值 → 当前值 = escalateTo。
 *    （escalateTo <= 静态 severity 已在加载期被 SopRuleConfigError 拒绝；
 *     此处重复守卫仅为对绕过加载器手工构造的输入保持安全——不升级即原样返回。）
 * 2. 基线升档：healthBaseline !== undefined 且 < 60 → 沿固定顺序恰好上移一档，
 *    封顶 critical（已在 critical 或未知值则不动）。
 *
 * 不修改入参 rule；registry 存储对象是否被复用由调用方决定。
 */
export function resolveSeverity(rule: SopRule, ctx: AdaptiveContext = {}): Severity {
  let current = rule.severity;

  const policy = rule.accumulationPolicy;
  if (policy && (ctx.consecutiveFailures ?? 0) >= (policy.threshold ?? 3)) {
    if (severityRank(policy.escalateTo) > severityRank(current)) {
      current = policy.escalateTo;
    }
  }

  if (ctx.healthBaseline !== undefined && ctx.healthBaseline < 60) {
    const idx = SEVERITY_ORDER.indexOf(current);
    // 未知值（idx=-1）与已封顶 critical（idx+1 越界）均不动
    const next = idx >= 0 ? SEVERITY_ORDER[idx + 1] : undefined;
    if (next !== undefined) current = next;
  }

  return current;
}

// ─── 引擎委托的评估侧状态机（自 SopRuleEngine 抽出的纯逻辑）───

/** F1-3：按连续失败计数与健康基线解析有效规则 — severity 升级时返回浅拷贝，不改 registry 原对象 */
export function resolveEffectiveRule(
  rule: SopRule,
  consecutiveFailures: ReadonlyMap<string, number>,
  healthBaseline: number | undefined,
): SopRule {
  const effective = resolveSeverity(rule, {
    consecutiveFailures: consecutiveFailures.get(rule.id) ?? 0,
    healthBaseline,
  });
  return effective === rule.severity ? rule : { ...rule, severity: effective };
}

/** F1-3：评估后更新连续失败计数 — passed 归零、failed/error +1、skipped 不动；每规则每次评估恰好调用一次 */
export function trackConsecutiveFailures(
  counters: Map<string, number>,
  ruleId: string,
  status: EvaluationStatus,
): void {
  switch (status) {
    case 'passed':
      counters.set(ruleId, 0);
      break;
    case 'failed':
    case 'error':
      counters.set(ruleId, (counters.get(ruleId) ?? 0) + 1);
      break;
    case 'skipped':
      break;
  }
}
