/**
 * 报告构建工具
 *
 * 为流水线报告附加汇总信息、抽取失败项，以及提取性能检测问题（纯函数，无 IPC 副作用）。
 */
import { t } from '@zh/i18n';
import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';

/** 从规则引擎报告抽取失败项，便于前端展示 */
export function collectFailedItems(
  stage: 'guard' | 'inspect',
  report: { evaluations?: Array<{ rule?: { id?: string; name?: string }; status?: string; message?: string }> } | null,
): Array<{ stage: string; id: string; name: string; message: string }> {
  if (!report?.evaluations) return [];
  return report.evaluations
    .filter((ev) => ev.status === 'failed' || ev.status === 'error')
    .map((ev) => ({
      stage,
      id: ev.rule?.id ?? 'unknown',
      name: ev.rule?.name ?? ev.rule?.id ?? t('pipeline.report.unknownRule'),
      message: ev.message ?? (ev.status === 'error' ? t('pipeline.report.executionError') : t('pipeline.report.failed')),
    }));
}

export function attachSummary(
  report: PipelineReport & { summary?: Record<string, unknown> },
): PipelineReport & { summary: Record<string, unknown> } {
  const g = report.guard as { total?: number; passed?: number; failed?: number; skipped?: number; errors?: number } | null;
  const i = report.inspect as { total?: number; passed?: number; failed?: number; skipped?: number; errors?: number } | null;
  const failedItems = [
    ...collectFailedItems('guard', report.guard as RuleEngineReport | null),
    ...collectFailedItems('inspect', report.inspect as RuleEngineReport | null),
  ];
  const guardTotal = g?.total ?? 0;
  const inspectTotal = i?.total ?? 0;
  report.summary = {
    scope: [t('pipeline.report.scopeGuard'), t('pipeline.report.scopeInspect')],
    guard: {
      total: guardTotal,
      passed: g?.passed ?? 0,
      failed: g?.failed ?? 0,
      skipped: g?.skipped ?? 0,
      errors: g?.errors ?? 0,
    },
    inspect: {
      total: inspectTotal,
      passed: i?.passed ?? 0,
      failed: i?.failed ?? 0,
      skipped: i?.skipped ?? 0,
      errors: i?.errors ?? 0,
    },
    total: guardTotal + inspectTotal,
    passed: (g?.passed ?? 0) + (i?.passed ?? 0),
    failed: (g?.failed ?? 0) + (i?.failed ?? 0),
    skipped: (g?.skipped ?? 0) + (i?.skipped ?? 0),
    errors: (g?.errors ?? 0) + (i?.errors ?? 0),
    failedItems,
  };
  return report as PipelineReport & { summary: Record<string, unknown> };
}

export interface PerformanceViolation {
  id: string;
  ruleId: string;
  severity: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  category?: string;
}

export interface PerformanceEvaluation {
  violations?: PerformanceViolation[];
}

export interface PerformanceReportIssue {
  id: string;
  ruleId: string;
  severity: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
}

export function collectPerformanceIssues(evaluations: PerformanceEvaluation[]): PerformanceReportIssue[] {
  const issues: PerformanceReportIssue[] = [];
  for (const ev of evaluations) {
    for (const v of ev.violations ?? []) {
      if (v.category !== 'performance') continue;
      issues.push({
        id: v.id,
        ruleId: v.ruleId,
        severity: v.severity,
        file: v.file,
        line: v.line,
        message: v.message,
        suggestion: v.suggestion,
        autoFixable: !!v.suggestion && v.suggestion.includes('自动修复'),
      });
    }
  }
  return issues;
}
