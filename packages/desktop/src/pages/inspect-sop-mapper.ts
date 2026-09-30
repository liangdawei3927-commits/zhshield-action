/**
 * 渲染侧 SOP 巡检结果映射器（P1a 引擎收敛）。
 *
 * SOP 模式下 runPipeline 返回的 PipelineReportData.inspect 字段并非 report-format 的
 * InspectionReportData（electron.d.ts 中 inspect?: InspectionReportData 为历史类型谎言），
 * 实为 @zh/kernel RuleEngineReport 经 serializePipelineReport JSON 序列化后的纯 JSON 形态。
 * 本文件在渲染侧将该形态映射为 InspectionReportData 供 InspectPage 直接消费。
 *
 * 收敛原则：主进程不改返回形状（避免破坏 Dashboard 对 report.summary / extractSummary 的兼容），
 * 渲染侧新增映射层消化类型差。输入以 unknown 收口并在本文件内做最小形状校验，杜绝把
 * 类型谎言传递进 UI。
 */

import type { InspectionReportData } from '../types/electron';

/** 序列化后的单条规则评估（RuleEvaluation 的 JSON 最小字段） */
export interface SerializedRuleEvaluation {
  rule: {
    id: string;
    name: string;
    description?: string;
    domain?: string;
  };
  status: 'passed' | 'failed' | 'error' | 'skipped';
  message?: string;
  files?: string[];
  violations?: Array<{
    severity: string;
    file: string;
    line?: number;
    message: string;
    category?: string;
  }>;
  durationMs?: number;
  timestamp?: string;
}

/** 序列化后的 RuleEngineReport（PipelineReportData.inspect 的真实运行时形态） */
export interface SerializedRuleEngineReport {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  ok: boolean;
  blockingCount?: number;
  evaluations: SerializedRuleEvaluation[];
  durationMs: number;
  timestamp: string;
}

type CheckStatus = InspectionReportData['checks'][number]['status'];

type CheckLike = InspectionReportData['checks'][number];

/** P0-1：问题判定——仅 fail/warn（实际违规）算问题，attention（未检测）不算。 */
export function isIssueStatus(status: CheckStatus): boolean {
  return status === 'fail' || status === 'warn';
}

/** issues 数据源：从全量 checks 挑出问题项（排除 attention/pass）。 */
export function selectIssueChecks(
  checks: readonly CheckLike[],
): InspectionReportData['checks'] {
  return checks.filter((c) => isIssueStatus(c.status));
}

function mapStatus(status: SerializedRuleEvaluation['status']): CheckStatus {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    // error（规则引擎内部出错）与 skipped（工具不可用/语言不适用）均不作"失败"计，
    // 映射为 attention（未检测/需关注），与既有 adapter 覆盖率缺口语义一致。
    case 'error':
    case 'skipped':
      return 'attention';
  }
}

function buildDetail(ev: SerializedRuleEvaluation): string {
  if (ev.violations && ev.violations.length > 0) {
    const lines = ev.violations
      .slice(0, 3)
      .map((v) => (v.line ? `${v.file}:${v.line} ${v.message}` : `${v.file} ${v.message}`));
    if (ev.violations.length > 3) lines.push(`… 等 ${ev.violations.length} 条违规`);
    return lines.join('；');
  }
  if (ev.message) return ev.message;
  return ev.rule.description ?? ev.rule.name;
}

function isSerializedRuleEngineReport(value: unknown): value is SerializedRuleEngineReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SerializedRuleEngineReport>;
  return Array.isArray(v.evaluations) && typeof v.total === 'number';
}

/**
 * 序列化 RuleEngineReport → InspectionReportData（渲染侧，SOP 数据源收敛）。
 * 输入 shape 不满足时返回 null（与 runInspect 失败回退一致，页面落空态）。
 */
export function toInspectionReportDataFromRuleEngine(raw: unknown): InspectionReportData | null {
  if (!isSerializedRuleEngineReport(raw)) return null;

  const checks: NonNullable<InspectionReportData['checks']> = raw.evaluations.map((ev) => ({
    id: ev.rule.id,
    name: ev.rule.name,
    status: mapStatus(ev.status),
    detail: buildDetail(ev),
    category: ev.violations?.find((v) => v.category)?.category ?? ev.rule.domain ?? undefined,
  }));

  const passedCount = checks.filter((c) => c.status === 'pass').length;
  const failureCount = checks.filter((c) => c.status === 'fail').length;
  // warn 当前不产生（mapStatus 只出 pass/fail/attention），保留按状态统计以维持
  // total = passed + warnings + failures 不变量与既有 toInspectionReportData 语义对齐。
  const warningCount = checks.filter((c) => c.status === 'warn' || c.status === 'attention').length;

  return {
    summary: {
      total: checks.length,
      passed: passedCount,
      warnings: warningCount,
      failures: failureCount,
    },
    checks,
    metadata: {
      duration: raw.durationMs ?? 0,
      timestamp: raw.timestamp ?? new Date().toISOString(),
    },
  };
}
