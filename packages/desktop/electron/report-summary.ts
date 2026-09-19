/**
 * 报告中心「只读汇总」的纯映射层（零 Electron 依赖，便于单测）。
 *
 * 背景（2026-09-18 导航各司其职改造 T10）：报告中心原先点「生成报告」会跑一遍
 * pipeline（runPipeline → recordPipelineScore），也就是**由报告中心代各域发起检查**，
 * 违反「触发权域内独占」。现在改为只读各域最新落盘结果再汇总评分。
 *
 * 汇总复用与 pipeline 完全相同的评分算法（buildHealthDimensions +
 * ScoringEngine.calculate），差别只在数据来源：pipeline 吃刚跑完的报告，
 * 汇总吃各域已持久化的结果。因此需要「落盘结果 → 算法输入形状」的映射，即本模块职责。
 */
import type { GuardCheckLike, InspectIssueLike } from '@zh/scoring';
import type { GuardReportRecord } from '@zh/guard';
import type { DiagnosticEntry } from './zh-diagnostics';

/**
 * 扩展域（secrets/deps/techdebt/refactor/performance/garbage/sentinel/backup）最新数据契约，
 * 对齐 @zh/scoring 的 DimensionExtras；无对应域时为 null（算法侧按 null 判 not-run）。
 */
export interface PipelineExtras {
  secrets?: { activeCount: number } | null;
  deps?: {
    vulnerabilities: { critical: number; high: number; medium: number };
    upgradable: number;
  } | null;
  techdebt?: { debtIndex: number; issueCount: number } | null;
  refactor?: {
    totalSmells: number;
    bySeverity: { error: number; warning: number; info: number };
  } | null;
  performance?: {
    total: number;
    bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
  } | null;
  garbage?: { total: number; byType: Record<string, number> } | null;
  sentinel?: { active: boolean; criticalEvents: number; warningEvents: number } | null;
  backup?: {
    lastSuccessAt: string | null;
    recentStatuses: string[];
    scheduleEnabled: boolean;
  } | null;
}

/** guard 报告记录中的单个检查项（见 @zh/guard GuardReportRecord.checks） */
export type GuardReportCheck = GuardReportRecord['checks'][number];

/**
 * guard 报告记录 → gate 维度用的检查结果。
 *
 * 为什么 gate 维度不用诊断快照（domains/guard.json）映射：
 * 诊断快照只保留**问题条目**，一个检查项产生 N 条 issue 就会被 guardPenalty 计罚 N 次；
 * 而 guardPenalty 是按「检查项状态」计罚的。两种粒度混用会让汇总分与 pipeline 分对不上、
 * 历史趋势断裂。guard 报告记录保留完整检查项（含通过项），故以它为准。
 */
export function toGuardChecks(checks: readonly GuardReportCheck[]): GuardCheckLike[] {
  return checks.map((check) => ({
    severity: check.severity,
    status: check.status,
    blocking: check.blocking,
  }));
}

/** 诊断条目 → quality/security/dependencies 维度用的 inspect 问题（维度映射只用 severity + category） */
export function toInspectIssues(issues: readonly DiagnosticEntry[]): InspectIssueLike[] {
  return issues.map((issue) => ({ severity: issue.severity, category: issue.category }));
}

/**
 * 扩展域是否有任一结果。
 *
 * 必须同时判 null 与 undefined：PipelineExtras 各字段可选，
 * 只判 `!== null` 会把 undefined 误认成「有结果」，从而在一穷二白的新项目上
 * 写出一条 0 分记录污染历史（未检测 ≠ 0 分）。
 */
export function hasAnyExtraResult(extras: PipelineExtras): boolean {
  return Object.values(extras).some((value) => value !== null && value !== undefined);
}
