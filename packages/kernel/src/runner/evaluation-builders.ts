import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleEvaluation, RuleEngineReport } from '../sop/_meta/rule-evaluation';

/**
 * 评估结果构造与聚合的纯函数集（自 SopRuleEngine 抽出，无 this 依赖）。
 * 与 inline-evaluators / dispatch-evaluators 同层：引擎类只做编排，不做对象拼装。
 */

/** 构造 skipped 评估结果（dryRun / 防重入等场景，不触发任何副作用） */
export function skipEvaluation(rule: SopRule, message: string, targetEngine: 'guard' | 'inspect'): RuleEvaluation {
  return {
    rule,
    status: 'skipped',
    message,
    durationMs: 0,
    targetEngine,
    timestamp: new Date(),
  };
}

/** 构造 error 评估结果（工具异常等场景） */
export function errorEvaluation(rule: SopRule, message: string, durationMs: number): RuleEvaluation {
  return {
    rule,
    status: 'error',
    message,
    durationMs,
    targetEngine: rule.domain === 'guard' ? 'guard' : 'inspect',
    timestamp: new Date(),
    blocking: false,
  };
}

/**
 * 聚合评估结果
 *
 * 有任何 blocking 级别的规则失败 → pipeline 不应 ok
 * 但 SOP 规则的 blocking 由触发方决定，这里只汇报数字
 */
export function aggregate(evaluations: RuleEvaluation[], durationMs: number): RuleEngineReport {
  const passed = evaluations.filter((e) => e.status === 'passed').length;
  const failed = evaluations.filter((e) => e.status === 'failed').length;
  const errors = evaluations.filter((e) => e.status === 'error').length;
  const skipped = evaluations.filter((e) => e.status === 'skipped').length;
  const blockingCount = evaluations.filter((e) => e.blocking === true).length;

  return {
    total: evaluations.length,
    passed,
    failed,
    errors,
    skipped,
    ok: failed === 0 && errors === 0,
    blockingCount,
    evaluations,
    durationMs,
    timestamp: new Date(),
  };
}
