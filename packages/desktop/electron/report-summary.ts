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
import { buildHealthDimensions, SCORE_VERSION } from '@zh/scoring';
import type { GuardCheckLike, GuardReportLike, InspectIssueLike } from '@zh/scoring';
import type { GuardReportRecord } from '@zh/guard';
import type { DiagnosticEntry, DiagnosticSource, DiagnosticsReport } from './zh-diagnostics';
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
  return issues.map((issue) => ({
    severity: issue.severity,
    category: issue.category,
    ruleId: issue.ruleId,
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
};

/**
 * quality 快路径：透传 inspect 快照落盘时当场算好的 dimensionScore + previousScore。
 *
 * performance 条目落在 `domains/performance.json`（按域分文件，不覆盖 inspect 快照），
 * 因此 inspect 快照自带评分里**不含**它们。有 performance 条目时按
 * 「inspect + performance」并集走一次 buildHealthDimensions 重算，与
 * {@link assembleHealthInputs} 交给 quality 维的输入完全同构（两者都只把
 * DIMENSION_CATEGORIES.quality 覆盖的类别计入），两条路径不可能漂移；
 * 没有 performance 条目时原样透传，快路径仍是零算分。
 */
export function qualityFastPathScore(
  snap: DiagnosticsReport | null,
  performanceSnap: DiagnosticsReport | null = null,
): QualityFastPathScore | null {
  if (!snap?.dimensionScore) return null;
  const passthrough = {
    ...snap.dimensionScore,
    generatedAt: snap.generatedAt,
    previousScore: snap.previousScore,
  };
  const performanceIssues = toInspectIssues(
    (performanceSnap?.issues ?? []).filter((issue) => issue.category === 'performance'),
  );
  if (performanceIssues.length === 0) return passthrough;
  // 调用形状与 zh-diagnostics 的 enrichInspectSnapshot 一致（不带 projectRoot/profile：
  // 维度分与权重无关），重算结果与落盘出分同口径。
  const [quality] = buildHealthDimensions({
    guard: null,
    inspect: {
      issues: [...toInspectIssues(snap.issues), ...performanceIssues],
      esloc: snap.esloc,
    },
  });
  if (quality?.name !== 'quality' || !quality.status) return passthrough;
  return {
    dimension: 'quality',
    score: quality.score,
    issues: quality.issues,
    status: quality.status,
    version: SCORE_VERSION,
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
 * 同理并入 performance 快照的 performance 类条目：按域分文件后它们落在
 * domains/performance.json，而 DIMENSION_CATEGORIES.quality 含 'performance'，
 * 不并入则 quality 维会静默丢掉这部分扣分（历史上它们是被写进 inspect 快照顺带进入的）。
 *
 * timestamps 各维度锚点来源：
 * - quality：max(inspect 快照 generatedAt, performance 快照 generatedAt)（巡检/性能两类数据源）
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
  const [inspectSnapshot, securitySnapshot, depsSnapshot, performanceSnapshot, state, extras] =
    await Promise.all([
      reads.readDomainSnapshot(projectPath, 'inspect'),
      reads.readDomainSnapshot(projectPath, 'security'),
      reads.readDomainSnapshot(projectPath, 'deps'),
      reads.readDomainSnapshot(projectPath, 'performance'),
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
  if (performanceSnapshot) {
    mergedIssues.push(
      ...toInspectIssues(
        performanceSnapshot.issues.filter((issue) => issue.category === 'performance'),
      ),
    );
  }

  const now = reads.now?.() ?? new Date().toISOString();
  const timestamps: Record<ScoreDimension, string | null> = {
    quality: maxTimestamp(inspectSnapshot?.generatedAt, performanceSnapshot?.generatedAt),
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
    guard: guardRecord ? { results: toGuardChecks(guardRecord.checks) } : null,
    inspectIssues: mergedIssues.length > 0 || inspectSnapshot !== null ? mergedIssues : null,
    esloc: inspectSnapshot?.esloc,
    extras,
    timestamps,
  };
}
