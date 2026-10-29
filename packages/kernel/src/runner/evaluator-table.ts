import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { ContentInstruction, RuleEvaluation } from '../sop/_meta/rule-evaluation';
import { skipEvaluation } from './evaluation-builders';
import type { EngineHost } from './evaluator-host';
import {
  evalPatternScan,
  evalForbidden,
  evalForbiddenRegex,
  evalRequiredContent,
  evalThreshold,
  evalLayerBoundary,
} from './inline-evaluators';
import { evalCheckList, evalScannerDispatch, evalToolDispatch, evalPreset } from './dispatch-evaluators';

/**
 * 指令类型 → 评估器策略表。
 *
 * 从 SopRuleEngine 类体抽出（2026-10-29）：这张表是**静态配置**，不依赖实例状态，
 * 唯一的外部依赖是派发时读取的 EngineHost。留在类里会让类体持续膨胀，
 * 每加一条指令都要动这个巨型类。
 *
 * 映射类型保证每个 handler 收到对应判别联合变体（类型安全）；
 * 分派处对联合索引做一次局部断言以绕过 TS 相关联合的索引限制。
 */
export type EvaluatorTable = Partial<{
  [K in ContentInstruction['type']]: (
    rule: SopRule,
    instr: Extract<ContentInstruction, { type: K }>,
    context: RuleContext,
  ) => RuleEvaluation | Promise<RuleEvaluation>;
}>;

export function buildEvaluatorTable(getHost: () => EngineHost): EvaluatorTable {
  return {
    'pattern-scan': (rule, instr, ctx) => evalPatternScan(rule, instr, ctx),
    forbidden: (rule, instr, ctx) => evalForbidden(rule, instr, ctx),
    'forbidden-regex': (rule, instr, ctx) => evalForbiddenRegex(rule, instr, ctx),
    'required-content': (rule, instr, ctx) => evalRequiredContent(rule, instr, ctx),
    threshold: (rule, instr, ctx) => evalThreshold(rule, instr, ctx),
    'check-list': (rule, instr, ctx) => evalCheckList(getHost(), rule, instr, ctx),
    'layer-boundary': (rule, instr, ctx) => evalLayerBoundary(rule, instr, ctx),
    'scanner-dispatch': (rule, instr, ctx) => evalScannerDispatch(getHost(), rule, instr, ctx),
    preset: (rule, instr, ctx) => evalPreset(getHost(), rule, instr, ctx),
    'tool-dispatch': (rule, instr, ctx) => evalToolDispatch(getHost(), rule, instr, ctx),
    // 盲检护栏：content 无法解释为任何可执行指令时不得判通过。
    // degraded=true → aggregate() 计入 ok 判定（ok=false），面板不再出现假的通过勾。
    unresolved: (rule, instr) =>
      skipEvaluation(
        rule,
        `规则内容无法解释，未执行任何检查：${instr.reason}`,
        rule.domain === 'guard' ? 'guard' : 'inspect',
        true,
      ),
  };
}
