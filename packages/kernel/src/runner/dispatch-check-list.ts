import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { RuleEvaluation, Violation, CheckListInstruction } from '../sop/_meta/rule-evaluation';
import type { EngineHost } from './evaluator-host';
import { skipEvaluation } from './evaluation-builders';
import { toMessage, errorResult } from './dispatch-shared';

// ─── 派发评估：check-list → GuardEngine ────────────────

export async function evalCheckList(
  host: EngineHost,
  rule: SopRule,
  instr: CheckListInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  // security 域 check-list 规则（缓存同步：helmet-check / comment-instruction /
  // dependency-scripts / env-exfiltration / hidden-link）→ SecurityCheckEngine。
  // 这些规则的 checks 是语义化检测项（如 helmet-configured），GuardEngine checks.json
  // 仅有 ARCH/LINT/TEST/SEC 四条 → 路由到 GuardEngine.run 会永久「无可匹配」跳过。
  // SecurityCheckEngine 为纯文件检测，不回调 evaluateRules（无重入），故先于 evalDepth
  // 切断路由——既消除『防重入』误跳，也避免并行评估时共享 evalDepth 计数器导致的漂移。
  if (rule.domain === 'security') {
    if (!host.securityCheckEngine) {
      return skipEvaluation(rule, 'SecurityCheckEngine 未注册，无法执行 check-list', 'inspect');
    }
    return runSecurityCheck(host.securityCheckEngine, rule, instr, context);
  }
  // 非 guard 域没有 check-list 执行器。
  // 旧实现把 inspect 域的 check-list 规则也派发给 GuardEngine：GuardEngine.run 带 SOP 引擎时
  // 会重入 evaluateRules 全量评估 guard 域，再按 options.checks 过滤结果 —— 与本规则声明的
  // 检查项毫无关系。实证：inspect.scan.official.null-safety（checks 三项均为 Guard 不存在的
  // 语义项）以「Guard 检查通过」假通过；同一批规则在并行池里遇到兄弟规则的嵌套派发时又被
  // 判成「跳过 check-list→GuardEngine.run（防止规则引擎重入）」→ 面板显示未检查。
  // 两者都是假象：这条规则从来没有被任何引擎执行过。故此处显式跳过并说明真实原因，
  // 既不假通过，也不再借用 GuardEngine 的结果冒充他域规则。
  if (rule.domain !== 'guard') {
    const names = instr.checks.map((c) => c.rule || '(未命名)').join('、') || '(无)';
    return skipEvaluation(
      rule,
      `该域无 check-list 执行器：声明 ${instr.checks.length} 项检查（${names}）没有任何引擎实现，未执行任何检查`,
      'inspect',
    );
  }
  if (!host.guardEngine) {
    return skipEvaluation(rule, 'GuardEngine 未注册，无法执行 check-list', 'guard', true);
  }
  if (host.evalDepth > 1) {
    return skipEvaluation(rule, '跳过 check-list→GuardEngine.run（防止规则引擎重入）', 'guard');
  }
  return runGuardCheck(host.guardEngine, rule, context);
}

async function runSecurityCheck(
  securityEngine: NonNullable<EngineHost['securityCheckEngine']>,
  rule: SopRule,
  instr: CheckListInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  try {
    const result = await securityEngine.run({
      mode: 'security',
      target: context.repoRoot,
      checks: instr.checks.map((c) => c.rule),
      dryRun: context.dryRun ?? false,
    });

    const violations = collectGuardViolations(result, rule);
    const results = result?.results ?? [];
    // 全部检测项都确知不适用（如无 Web 框架时的 Helmet/CSRF）→ 规则整体不适用。
    // 任一检测项可检即保持普通 passed/failed：混合场景下规则确实被执行过。
    const notApplicable =
      results.length > 0 && results.every((r) => r.applicability === 'not-applicable');
    if (notApplicable) {
      const reasons = results
        .map((r) => r.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0);
      return {
        rule,
        status: 'passed',
        applicability: 'not-applicable',
        violations,
        message: reasons.join('；') || '规则的检测对象在本项目中不存在，检查不适用',
        durationMs: 0,
        targetEngine: 'inspect',
        timestamp: new Date(),
      };
    }
    return {
      rule,
      status: violations.length === 0 ? 'passed' : 'failed',
      violations,
      message: violations.length > 0 ? `安全检查发现 ${violations.length} 个问题` : '安全检查通过',
      durationMs: 0,
      targetEngine: 'inspect',
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(rule, `安全引擎派发失败: ${toMessage(err)}`, 'inspect');
  }
}

async function runGuardCheck(
  guardEngine: NonNullable<EngineHost['guardEngine']>,
  rule: SopRule,
  context: RuleContext,
): Promise<RuleEvaluation> {
  try {
    const result = await guardEngine.run({
      mode: 'guard',
      target: context.repoRoot,
      checks: [rule.id],
      dryRun: context.dryRun ?? false,
    });

    const violations = collectGuardViolations(result, rule);
    return {
      rule,
      status: violations.length === 0 ? 'passed' : 'failed',
      violations,
      message:
        violations.length > 0 ? `Guard 检查发现 ${violations.length} 个问题` : 'Guard 检查通过',
      durationMs: 0,
      targetEngine: 'guard',
      timestamp: new Date(),
    };
  } catch (err) {
    const msg = toMessage(err);
    // 规则 content 的 checks 与传统 checkId 体系不对应时（如 TS 编译器选项类规则
    // 被解释为 check-list），派发无匹配属于跳过而非错误——升级为 error 会产生
    // 无 location 的 error 级误报，阻断门禁且 SARIF 上传被 GitHub 拒绝
    if (msg.includes('no checks matched the current filters')) {
      return skipEvaluation(rule, `无可匹配的 Guard 检查，跳过派发: ${msg}`, 'guard');
    }
    return errorResult(rule, `Guard 派发失败: ${msg}`, 'guard');
  }
}

function collectGuardViolations(
  result: { results?: Array<{ status?: string; message?: string }> } | null | undefined,
  rule: SopRule,
): Violation[] {
  const violations: Violation[] = [];
  if (!result?.results) return violations;

  for (const r of result.results) {
    if (r.status === 'failed' || r.status === 'error') {
      violations.push({
        id: randomUUID(),
        ruleId: rule.id,
        severity: rule.severity,
        file: '',
        message: r.message ?? `Check failed: ${rule.id}`,
      });
    }
  }
  return violations;
}
