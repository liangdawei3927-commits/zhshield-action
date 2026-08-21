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
  mergeReports(inspectReport: RuleEngineReport, securityReport: RuleEngineReport): RuleEngineReport {
    return {
      ...inspectReport,
      total: inspectReport.total + securityReport.total,
      passed: inspectReport.passed + securityReport.passed,
      failed: inspectReport.failed + securityReport.failed,
      errors: inspectReport.errors + securityReport.errors,
      skipped: inspectReport.skipped + securityReport.skipped,
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
            severity: v.severity === 'critical' || v.severity === 'high' ? 'error'
              : v.severity === 'medium' ? 'warning'
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
      issues: ev.violations
        ? ev.violations.map((v) => ({
            id: v.id,
            ruleId: v.ruleId,
            severity: v.severity === 'critical' || v.severity === 'high' ? 'error' as const
              : v.severity === 'medium' ? 'warning' as const
              : 'info' as const,
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
