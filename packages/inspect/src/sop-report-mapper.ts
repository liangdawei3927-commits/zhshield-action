import type { AdapterResult, Issue, IssueCategory } from './types';
import type { RuleEngineReport } from '@zh/kernel';

/**
 * SopReportMapper — SOP 评估报告 → Inspect 报告结构映射
 *
 * 将 SopRuleEngine 返回的 RuleEngineReport 映射为 InspectEngine
 * 需要的 Issue[] 与 AdapterResult[] 结构，并负责合并
 * inspect / security 两个域的评估报告。
 */
export class SopReportMapper {
  /** 合并 inspect / security 两个域的评估报告 */
  mergeReports(
    inspectReport: RuleEngineReport,
    securityReport: RuleEngineReport,
  ): RuleEngineReport {
    return {
      ...inspectReport,
      total: inspectReport.total + securityReport.total,
      passed: inspectReport.passed + securityReport.passed,
      failed: inspectReport.failed + securityReport.failed,
      errors: inspectReport.errors + securityReport.errors,
      skipped: inspectReport.skipped + securityReport.skipped,
      degraded: (inspectReport.degraded ?? 0) + (securityReport.degraded ?? 0),
      ok: inspectReport.ok && securityReport.ok,
      evaluations: [...inspectReport.evaluations, ...securityReport.evaluations],
      durationMs: inspectReport.durationMs + securityReport.durationMs,
    };
  }

  flattenViolations(report: RuleEngineReport): Issue[] {
    const issues: Issue[] = [];
    for (const ev of report.evaluations) {
      if (ev.violations && ev.violations.length > 0) {
        for (const v of ev.violations) {
          issues.push({
            id: v.id,
            ruleId: v.ruleId,
            severity:
              v.severity === 'critical' || v.severity === 'high'
                ? 'error'
                : v.severity === 'medium'
                  ? 'warning'
                  : 'info',
            category: v.category ?? 'quality',
            message: v.message,
            file: v.file,
            line: v.line,
            column: v.column,
            suggestion: v.suggestion,
            autoFixable: false,
            source: ev.rule?.domain ?? 'inspect',
            fingerprint: `${v.ruleId}:${v.file}:${v.line ?? 0}`,
          });
        }
      }
    }
    return issues;
  }

  buildAdapterResults(report: RuleEngineReport): AdapterResult[] {
    return report.evaluations.map((ev) => ({
      adapterId: ev.rule?.id ?? 'unknown',
      adapterName: ev.rule?.name ?? ev.rule?.id ?? 'unknown',
      duration: ev.durationMs,
      issueCount: ev.violations?.length ?? 0,
      passed: ev.status === 'passed',
      status: ev.status === 'passed' ? ('passed' as const) : ev.status,
      // P0（复查4）：degraded 与跳过原因必须透传到报告层——此前只搬 7 个字段，
      // 消费方（JSON 报告 / CLI 护栏 / 桌面端）完全看不到"未检测"及其原因，
      // 造成 8 项全跳过仍 100 分通过的盲检面。
      degraded: ev.degraded === true,
      skipReason:
        ev.status === 'skipped'
          ? ev.degraded === true
            ? ('degraded' as const)
            : ('out-of-scope' as const)
          : undefined,
      skipDetail: ev.status === 'skipped' && ev.message ? ev.message : undefined,
      // P1（复查5）：error 的真实原因同样必须透传——此前 error 评估的 message
      // 被整条丢弃，报告层只剩 `status:'error', issues:[]`（无原因可查）。
      errorDetail: ev.status === 'error' && ev.message ? ev.message : undefined,
      issues: ev.violations
        ? ev.violations.map((v) => ({
            id: v.id,
            ruleId: v.ruleId,
            severity:
              v.severity === 'critical' || v.severity === 'high'
                ? ('error' as const)
                : v.severity === 'medium'
                  ? ('warning' as const)
                  : ('info' as const),
            category: (v.category ?? 'quality') as IssueCategory,
            message: v.message,
            file: v.file,
            line: v.line,
            column: v.column,
            suggestion: v.suggestion,
            autoFixable: false,
            source: ev.rule?.domain ?? 'inspect',
            fingerprint: `${v.ruleId}:${v.file}:${v.line ?? 0}`,
          }))
        : [],
    }));
  }
}
