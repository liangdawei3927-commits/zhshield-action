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
import { buildHealthDimensions, isPenaltyExemptRuleId, SCORE_VERSION } from '@zh/scoring';
import type { GuardCheckLike, GuardReportLike, InspectIssueLike } from '@zh/scoring';
import type { GuardReportRecord } from '@zh/guard';
import type { DiagnosticEntry, DiagnosticSource, DiagnosticsReport } from './zh-diagnostics';
import type { RuleCoverage } from './zh-diagnostics-types';
import type { DashboardState } from './ipc/dashboard-state';

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
    /** P1-9：实际扫描文件数；undefined = 旧数据无此字段（不参与 0 覆盖判定） */
    scannedFiles?: number;
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

/** 诊断条目 → quality/security/dependencies 维度用的 inspect 问题（维度映射用 severity+category，S1 规则聚合另需 ruleId） */
export function toInspectIssues(issues: readonly DiagnosticEntry[]): InspectIssueLike[] {
  return issues
    .filter((issue) => issue.toolError !== true)
    .map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      ruleId: issue.ruleId,
      // R5：secret:/cve:/upgrade: 由绝对口径（secretsPenalty/depsPenalty/不扣分）接管，
      // 这里只标记「可计数、不可再扣条目分」，避免同一事实在同一维度扣两次。
      // 前缀兜底在 scoring 侧也有一份，旧调用方漏标记时仍能去重。
      ...(issue.ruleId && isPenaltyExemptRuleId(issue.ruleId) ? { penaltyExempt: true } : {}),
    }));
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

// ─── 输入组装（报告中心汇总 ② 与分类页实时评分共用） ─────────────────

import { SCORE_DIMENSIONS, isScoreDimension } from '@zh/shared';
import type { ScoreDimension } from '@zh/shared';

export { SCORE_DIMENSIONS, isScoreDimension };
export type { ScoreDimension };
/**
 * buildHealthDimensions 的输入（报告中心汇总 ② 与分类页实时评分共用，
 * 两条路径结构上不可能漂移）。
 */
export interface HealthInputs {
  /** gate 维度输入：最近一次 guard 报告记录（listGuardReports[0]）；无记录 → null */
  guard: GuardReportLike | null;
  /**
   * quality/security/dependencies 维度输入：inspect 快照条目 + Q4 并入的
   * security/deps 专用扫描条目；无任何来源 → null（各维按 not-run 处理）。
   */
  inspectIssues: InspectIssueLike[] | null;
  /**
   * quality 维的数据源是否真的跑过（**只认 inspect 巡检**）。
   *
   * `inspectIssues` 是给三个维共用的条目袋，只跑 security 扫描时它非空，
   * 但那只是 security 条目 —— 据此判 quality 已覆盖会给出 100 分
   * （没巡检 ≠ 质量满分，《07》A2）。performance 是独立计分类，同样不算
   * quality 覆盖（R5 §3.2）。
   */
  qualityCovered: boolean;
  /**
   * 本轮规则执行账（R6，仅 inspect 快照携带）。
   * 缺省 = 旧快照没有规则账（覆盖未知），不判 partial。
   */
  inspectRuleCoverage?: RuleCoverage;
  /** 项目 ESLOC（S2 密度归一化分母）。来自 inspect 快照落盘时算好的值，与落盘出分同口径 */
  esloc?: number;
  /** 扩展域数据（secrets/deps/techdebt/refactor/performance/garbage/sentinel/backup） */
  extras: PipelineExtras;
  /** 各维度新鲜度锚点（generatedAt 来源见 assembleHealthInputs 内注释）；无该域时间锚点 → null */
  timestamps: Record<ScoreDimension, string | null>;
}

/** assembleHealthInputs 的外部读取依赖（注入以便零 Electron 依赖单测） */
export interface HealthInputReads {
  listGuardReports: (projectPath: string) => GuardReportRecord[];
  readDomainSnapshot: (
    projectPath: string,
    source: DiagnosticSource,
  ) => Promise<DiagnosticsReport | null>;
  readDashboardState: (projectPath: string) => Promise<DashboardState>;
  buildPipelineExtras: (projectPath: string) => Promise<PipelineExtras>;
  /** 哨兵/备份为实时状态维，时间锚点取「现在」；测试可注入固定时钟 */
  now?: () => string;
}

/** 取多个 ISO 时间戳中的最新者（ISO 字符串字典序即时间序）；全空 → null */
function maxTimestamp(...values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (valid.length === 0) return null;
  return valid.reduce((max, v) => (v > max ? v : max));
}

/** quality 快路径返回：inspect 快照自带评分 + 对比基线（无快照或无评分 → null） */
export type QualityFastPathScore = {
  dimension: 'quality';
  score: number;
  issues: number;
  status: 'scored' | 'not-run';
  version?: number;
  generatedAt: string;
  previousScore?: { score: number; generatedAt: string };
  /** 规则级覆盖（R6）：缺省 = 旧快照没有规则账（覆盖未知） */
  coverage?: { run: number; total: number; complete: boolean };
};

/**
 * quality 快路径：透传 inspect 快照落盘时当场算好的 dimensionScore + previousScore。
 *
 * R5：performance 域条目**不再并入 quality**。performance 是独立计分类
 * （`dimension='performance'`，输入是 `extras.performance` 摘要），它的问题
 * 已在 performance 维扣分；再并进 quality 就是同一事实扣两次。
 * inspect 自己产的 `performance` 类别规则仍留在 inspect 快照里，随本快路径计入
 * quality——那是 inspect 的 Owner 事实，不是 performance 域的结论。
 *
 * 因此本函数不再需要 performance 快照参数：quality 的唯一数据源是 inspect 快照。
 */
export function qualityFastPathScore(snap: DiagnosticsReport | null): QualityFastPathScore | null {
  if (!snap?.dimensionScore) return null;
  // dimension 显式收窄为 'quality'：DomainDimensionScore.dimension 已放宽为五域联合
  // （security/deps/garbage/performance 快照也带分了），inspect 快照恒为 quality 维
  return {
    ...snap.dimensionScore,
    dimension: 'quality' as const,
    generatedAt: snap.generatedAt,
    previousScore: snap.previousScore,
  };
}

/**
 * 组装 buildHealthDimensions 的输入（报告中心汇总 ② 与分类页实时评分共用）。
 *
 * 评分输入缺口修复（Q4）：security/deps 专用扫描的发现此前从未进入评分——
 * 汇总只读 inspect 快照，意味着「只跑了 security 扫描」时 security 维永远 not-run，
 * 安全页刚扫完仍显示「未检测」。现在把 security 快照的 security 类条目与 deps 快照的
 * dependency 类条目并入 inspectIssues（仅并入 DIMENSION_CATEGORIES 覆盖的类别；
 * malware/license/environment 不在十域映射内，不并入），使专用扫描结果终于进入
 * buildHealthDimensions。
 *
 * **不并入 performance 快照**（R5）：performance 是独立计分类，按
 * `extras.performance` 摘要计分；把它再并进 quality 会让同一性能问题扣两次。
 * inspect 自己产的 `performance` 类别条目仍在 inspect 快照里，随 quality 计分。
 *
 * timestamps 各维度锚点来源：
 * - quality：inspect 快照 generatedAt（performance 域有自己的锚点）
 * - gate：guard 报告记录 timestamp（listGuardReports 新→旧取 [0]）
 * - security：max(dashboard-state.secrets.lastRunAt, security 快照 generatedAt)（合并来源）
 * - dependencies：max(dashboard-state.deps.lastRunAt, deps 快照 generatedAt)（合并来源）
 * - techdebt/refactor/performance/garbage：dashboard-state 对应域 lastRunAt
 * - sentinel/backup：实时状态维（哨兵事件中心 / 备份记录实时读取），锚点取「现在」
 */
export async function assembleHealthInputs(
  projectPath: string,
  reads: HealthInputReads,
): Promise<HealthInputs> {
  const guardRecord = reads.listGuardReports(projectPath)[0] ?? null;
  const [inspectSnapshot, securitySnapshot, depsSnapshot, state, extras] = await Promise.all([
    reads.readDomainSnapshot(projectPath, 'inspect'),
    reads.readDomainSnapshot(projectPath, 'security'),
    reads.readDomainSnapshot(projectPath, 'deps'),
    reads.readDashboardState(projectPath),
    reads.buildPipelineExtras(projectPath),
  ]);

  const mergedIssues: InspectIssueLike[] = [];
  if (inspectSnapshot) mergedIssues.push(...toInspectIssues(inspectSnapshot.issues));
  if (securitySnapshot) {
    mergedIssues.push(
      ...toInspectIssues(securitySnapshot.issues.filter((issue) => issue.category === 'security')),
    );
  }
  if (depsSnapshot) {
    mergedIssues.push(
      ...toInspectIssues(depsSnapshot.issues.filter((issue) => issue.category === 'dependency')),
    );
  }
  // R5：不再并入 performance 快照。performance 是独立计分类，其条目只在
  // extras.performance 里按摘要计分；并进 quality 会让同一性能问题扣两次。

  const now = reads.now?.() ?? new Date().toISOString();
  const timestamps: Record<ScoreDimension, string | null> = {
    // quality 的唯一数据源是 inspect 快照（performance 域有自己的时间锚点）
    quality: inspectSnapshot?.generatedAt ?? null,
    gate: guardRecord?.timestamp ?? null,
    security: maxTimestamp(state.secrets?.lastRunAt, securitySnapshot?.generatedAt),
    dependencies: maxTimestamp(state.deps?.lastRunAt, depsSnapshot?.generatedAt),
    techdebt: state.techdebt?.lastRunAt ?? null,
    refactor: state.refactor?.lastRunAt ?? null,
    performance: state.performance?.lastRunAt ?? null,
    garbage: state.garbage?.lastRunAt ?? null,
    sentinel: now,
    backup: now,
  };

  return {
    // total 显式透传：门禁零覆盖（一条规则都没跑）时 gate 维必须是 not-run 而非 100 分
    // （契约《07》§八 A8）。历史落库记录可能没有 summary → 省略该字段，退回按 results 计分。
    guard: guardRecord
      ? { results: toGuardChecks(guardRecord.checks), total: guardRecord.summary?.total }
      : null,
    inspectIssues: mergedIssues.length > 0 || inspectSnapshot !== null ? mergedIssues : null,
    // quality 维的覆盖判定只看 inspect 快照：security/deps 条目并入只是为了让它们
    // 各自的维度计分；performance 是独立计分类，不代表质量域跑过（R5 §3.2）。
    qualityCovered: inspectSnapshot !== null,
    ...(inspectSnapshot?.ruleCoverage
      ? { inspectRuleCoverage: inspectSnapshot.ruleCoverage }
      : {}),
    esloc: inspectSnapshot?.esloc,
    extras,
    timestamps,
  };
}
