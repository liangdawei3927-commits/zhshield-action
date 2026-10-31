/**
 * 门禁纯判定（《07》O8 / C3）：guard 域的 tool-dispatch 不执行工具，只读结论。
 *
 * 触发条件：调用方在 `RuleContext.conclusions` 注入了各域结论集合（desktop /
 * pipeline 会注入；未注入的存量调用方与单测保持历史上的工具派发行为）。
 *
 * 判定规则：
 *   · 工具 → 供应商域：来自 `resolveSupplierDomain`（TOOL_CAPABILITIES 单一来源）。
 *   · 供应商域无结论（本次未运行）→ skipped 且**不标 degraded**：这是「由其它阶段判定」
 *     的让位语义（C4：不进 issues、不判通过），不是问题，也不得伪造成 passed。
 *   · 有结论：取该域中达到规则严重级的问题（`toolError` 条目是工具故障不是代码问题，
 *     直接排除）。有命中 → failed；无命中 → passed，消息回显快照时间。
 *
 * 副作用恒为 0：本模块不触碰任何 ToolAdapter / 进程。
 */
import type { DomainConclusionSet, ConclusionIssue } from '@zh/shared';
import { resolveSupplierDomain } from '@zh/shared';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  ToolDispatchInstruction,
} from '../sop/_meta/rule-evaluation';
import { skipEvaluation } from './evaluation-builders';

/** 结论严重级 → 秩（与 SEVERITY_RANK 的 error/high/critical 同档，'warning' 对齐 medium） */
const CONCLUSION_RANK: Record<ConclusionIssue['severity'], number> = {
  info: 1,
  warning: 2,
  error: 3,
};

/** 规则严重级 → 结论严重级下限（达到或高于它才算命中） */
const RULE_SEVERITY_FLOOR: Record<string, number> = {
  info: 1,
  low: 1,
  medium: 2,
  warning: 2,
  error: 3,
  high: 3,
  critical: 3,
};

/** 结论严重级 → Violation 严重级（结论只有三档，映射到 SOP 的五档里最接近的档位） */
const VIOLATION_SEVERITY: Record<ConclusionIssue['severity'], Violation['severity']> = {
  error: 'high',
  warning: 'medium',
  info: 'low',
};

/** 读取某供应商域的结论；未注入返回 undefined（= 该域本次未运行） */
function readConclusion(
  conclusions: DomainConclusionSet | undefined,
  domain: ReturnType<typeof resolveSupplierDomain>,
): ConclusionIssue[] | null {
  if (!domain) return null;
  const conclusion = conclusions?.[domain];
  return conclusion ? [...conclusion.issues] : null;
}

/** 门禁纯判定入口：由 tool-dispatch 在 guard 域且已注入结论时调用 */
export function evalGuardConclusion(
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
): RuleEvaluation {
  const supplier = resolveSupplierDomain(instr.tool);
  const issues = readConclusion(context.conclusions, supplier);

  if (!supplier) {
    return skipEvaluation(
      rule,
      `门禁纯判定（O8）：工具「${instr.tool}」在能力表中无归属域，无法定位结论来源，跳过（不判通过）`,
      'guard',
    );
  }
  if (issues === null) {
    return skipEvaluation(
      rule,
      `门禁纯判定（O8）：未获得 ${supplier} 域结论（该域本次未运行或不支持只读复用），不启动工具、不判通过`,
      'guard',
    );
  }

  const floor = RULE_SEVERITY_FLOOR[rule.severity] ?? RULE_SEVERITY_FLOOR.info;
  const findings = issues.filter(
    (issue) => issue.toolError !== true && (CONCLUSION_RANK[issue.severity] ?? 0) >= floor,
  );
  const generatedAt = context.conclusions?.[supplier]?.generatedAt ?? '';

  if (findings.length === 0) {
    return {
      rule,
      status: 'passed',
      violations: [],
      message: `只读判定（O8）：${supplier} 域结论无达到 ${rule.severity} 级的问题（快照 ${generatedAt}）`,
      durationMs: 0,
      targetEngine: 'guard',
      timestamp: new Date(),
    };
  }

  return {
    rule,
    status: 'failed',
    violations: findings.map(toViolation(rule)),
    files: [...new Set(findings.map((issue) => issue.file).filter(Boolean))],
    message: `只读判定（O8）：${supplier} 域结论 ${findings.length} 处问题达到 ${rule.severity} 级（快照 ${generatedAt}），门禁未执行任何扫描`,
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

/** 结论条目 → SOP 违规条目（保留 RuleEvaluation 的形状，供门禁报告消费） */
function toViolation(rule: SopRule): (issue: ConclusionIssue) => Violation {
  return (issue) => ({
    id: `${issue.ruleId}:${issue.file}:${issue.line ?? 0}:${issue.message}`,
    ruleId: rule.id,
    severity: VIOLATION_SEVERITY[issue.severity],
    file: issue.file,
    line: issue.line,
    column: issue.column,
    message: issue.message,
    suggestion: issue.suggestion,
  });
}
