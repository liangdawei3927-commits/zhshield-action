import type { DimensionScore, SecretDataLike, DepsDataLike, SentinelDataLike, RefactorDataLike, PerformanceDataLike, GarbageDataLike, BackupDataLike } from './types';
import type {
  GuardReportLike,
  InspectIssueLike,
  InspectionReportLike,
} from './pipeline-score-penalties';
import {
  qualityPenalty,
  penaltyForIssues,
  guardPenalty,
  guardIssueCount,
  secretsPenalty,
  depsPenalty,
  sentinelPenalty,
  garbagePenalty,
  backupPenalty,
  refactorPenalty,
  performancePenalty,
} from './pipeline-score-penalties';

function notRun(name: string, weight: number): DimensionScore {
  return { name, weight, score: 0, issues: 0, status: 'not-run' };
}

// 导出原因：composite 项目声明产物需要（ScoreDimensionParams 引用本类型），未经枢纽 re-export，包公开 API 不变
export interface ExtrasResolved {
  secrets: SecretDataLike | null;
  deps: DepsDataLike | null;
  techdebt: { debtIndex: number; issueCount: number } | null;
  sentinel: SentinelDataLike | null;
  refactor: RefactorDataLike | null;
  performance: PerformanceDataLike | null;
  garbage: GarbageDataLike | null;
  backup: BackupDataLike | null;
}

/** scoreDimension 参数对象 */
export interface ScoreDimensionParams {
  name: string;
  categories: string[];
  weightMap: Record<string, number>;
  guard: GuardReportLike | null;
  inspect: InspectionReportLike | null;
  extras: ExtrasResolved;
}

export function scoreDimension(params: ScoreDimensionParams): DimensionScore {
  const { name, categories, weightMap, guard, inspect, extras } = params;
  const weight = weightMap[name] ?? 0;
  const issues = inspect?.issues ?? [];
  const matched = issues.filter((issue) => categories.includes(issue.category));

  const notRunResult = notRunDimension(params, matched);
  if (notRunResult) return notRunResult;

  switch (name) {
    case 'techdebt':
      return scoreTechdebt(name, weight, extras.techdebt);
    case 'refactor':
      return scoreRefactor(name, weight, extras.refactor);
    case 'performance':
      return scorePerformance(name, weight, extras.performance);
    case 'gate':
      return scoreGate(name, weight, guard);
    case 'sentinel':
      return scoreSentinel(name, weight, extras.sentinel);
    case 'garbage':
      return scoreGarbage(name, weight, extras.garbage);
    case 'backup':
      return scoreBackup(name, weight, extras.backup);
    default:
      return scoreInspectBased({ name, weight, inspect, extras, matched });
  }
}

/** 未检测语义（spec C）：某域从未运行时该域不参与加权且标注 not-run，禁止按满分计 */
function notRunDimension(
  params: ScoreDimensionParams,
  matched: InspectIssueLike[],
): DimensionScore | null {
  const { name, guard, inspect, extras } = params;
  const weight = params.weightMap[name] ?? 0;
  const checkers: Array<() => DimensionScore | null> = [
    () => checkQualityNotRun(name, inspect, weight),
    () => checkSecurityNotRun(name, extras.secrets, matched, weight),
    () => checkDependenciesNotRun(name, extras.deps, matched, weight),
    () => checkTechdebtNotRun(name, extras.techdebt, weight),
    () => checkRefactorNotRun(name, extras.refactor, weight),
    () => checkPerformanceNotRun(name, extras.performance, weight),
    () => checkGateNotRun(name, guard, weight),
    () => checkSentinelNotRun(name, extras.sentinel, weight),
    () => checkGarbageNotRun(name, extras.garbage, weight),
    () => checkBackupNotRun(name, extras.backup, weight),
  ];
  for (const checker of checkers) {
    const result = checker();
    if (result !== null) return result;
  }
  return null;
}

function checkQualityNotRun(
  name: string,
  inspect: InspectionReportLike | null,
  weight: number,
): DimensionScore | null {
  if (name === 'quality' && inspect === null) return notRun(name, weight);
  return null;
}

function checkSecurityNotRun(
  name: string,
  secrets: SecretDataLike | null,
  matched: InspectIssueLike[],
  weight: number,
): DimensionScore | null {
  if (name === 'security' && secrets === null && matched.length === 0) {
    return notRun(name, weight);
  }
  return null;
}

function checkDependenciesNotRun(
  name: string,
  deps: DepsDataLike | null,
  matched: InspectIssueLike[],
  weight: number,
): DimensionScore | null {
  if (name === 'dependencies' && deps === null && matched.length === 0) {
    return notRun(name, weight);
  }
  return null;
}

function checkTechdebtNotRun(
  name: string,
  techdebt: ExtrasResolved['techdebt'],
  weight: number,
): DimensionScore | null {
  if (name === 'techdebt' && techdebt === null) return notRun(name, weight);
  return null;
}

function checkRefactorNotRun(
  name: string,
  refactor: ExtrasResolved['refactor'],
  weight: number,
): DimensionScore | null {
  if (name === 'refactor' && refactor === null) return notRun(name, weight);
  return null;
}

function checkPerformanceNotRun(
  name: string,
  performance: ExtrasResolved['performance'],
  weight: number,
): DimensionScore | null {
  if (name === 'performance' && performance === null) return notRun(name, weight);
  return null;
}

function checkGateNotRun(
  name: string,
  guard: GuardReportLike | null,
  weight: number,
): DimensionScore | null {
  if (name === 'gate' && guard === null) return notRun(name, weight);
  return null;
}

function checkSentinelNotRun(
  name: string,
  sentinel: ExtrasResolved['sentinel'],
  weight: number,
): DimensionScore | null {
  if (name === 'sentinel' && sentinel === null) return notRun(name, weight);
  return null;
}

function checkGarbageNotRun(
  name: string,
  garbage: ExtrasResolved['garbage'],
  weight: number,
): DimensionScore | null {
  if (name === 'garbage' && garbage === null) return notRun(name, weight);
  return null;
}

function checkBackupNotRun(
  name: string,
  backup: ExtrasResolved['backup'],
  weight: number,
): DimensionScore | null {
  if (name === 'backup' && backup === null) return notRun(name, weight);
  return null;
}

/**
 * 维度分统一出口：扣分 → [0, 100] 闭区间分数（1 位小数）。
 *
 * 原实现 8 处各写 `Math.max(0, ...)`，只有下界没有上界：任何算出负扣分的路径
 * （未来新增的加分项，或除零/溢出产生的 -Infinity）都会让分数 > 100，
 * 而 HealthRing / ScoreRing 的进度弧按 `score / 100` 算 dashoffset，
 * >100 即负偏移，弧整个画不出来。同时兜住非有限值：
 * `Math.max(0, NaN) === NaN`，非有限扣分会让分数环渲染成空白而非显示 0。
 */
function toDimensionScore(penalty: number): number {
  if (!Number.isFinite(penalty)) return 0;
  return Math.round(Math.min(100, Math.max(0, 100 - penalty)) * 10) / 10;
}

function scoreTechdebt(
  name: string,
  weight: number,
  techdebt: ExtrasResolved['techdebt'],
): DimensionScore {
  // 局部捕获 + 空值守卫：TS 无法跨 name 收窄 extras.techdebt，守卫保留 not-run 语义
  if (techdebt === null) return notRun(name, weight);
  const debtIndex = techdebt.debtIndex;
  return {
    name,
    weight,
    score: toDimensionScore(debtIndex),
    issues: techdebt.issueCount,
    status: 'scored',
  };
}

function scoreRefactor(
  name: string,
  weight: number,
  refactor: ExtrasResolved['refactor'],
): DimensionScore {
  if (refactor === null) return notRun(name, weight);
  const penalty = refactorPenalty(refactor);
  return {
    name,
    weight,
    score: toDimensionScore(penalty),
    issues: refactor.totalSmells,
    status: 'scored',
  };
}

function scorePerformance(
  name: string,
  weight: number,
  performance: ExtrasResolved['performance'],
): DimensionScore {
  if (performance === null) return notRun(name, weight);
  const penalty = performancePenalty(performance);
  return {
    name,
    weight,
    score: toDimensionScore(penalty),
    issues: performance.total,
    status: 'scored',
  };
}

function scoreGate(name: string, weight: number, guard: GuardReportLike | null): DimensionScore {
  // v2（十域评分章程）：哨兵告警已拆出独立 sentinel 维，gate 只吃 guard 检查结果
  const gPenalty = guard ? guardPenalty(guard.results) : 0;
  const gCount = guard ? guardIssueCount(guard.results) : 0;
  return {
    name,
    weight,
    score: toDimensionScore(gPenalty),
    issues: gCount,
    status: 'scored',
  };
}

function scoreSentinel(
  name: string,
  weight: number,
  sentinel: ExtrasResolved['sentinel'],
): DimensionScore {
  if (sentinel === null) return notRun(name, weight);
  const sPenalty = sentinelPenalty(sentinel);
  return {
    name,
    weight,
    score: toDimensionScore(sPenalty),
    issues: sentinel.criticalEvents + sentinel.warningEvents,
    status: 'scored',
  };
}

function scoreGarbage(
  name: string,
  weight: number,
  garbage: ExtrasResolved['garbage'],
): DimensionScore {
  if (garbage === null) return notRun(name, weight);
  const penalty = garbagePenalty(garbage);
  return {
    name,
    weight,
    score: toDimensionScore(penalty),
    issues: garbage.total,
    status: 'scored',
  };
}

function scoreBackup(
  name: string,
  weight: number,
  backup: ExtrasResolved['backup'],
): DimensionScore {
  if (backup === null) return notRun(name, weight);
  const penalty = backupPenalty(backup);
  const bad = backup.recentStatuses.filter((s) => s === 'failed' || s === 'partial').length;
  return {
    name,
    weight,
    score: toDimensionScore(penalty),
    issues: bad,
    status: 'scored',
  };
}

function scoreInspectBased(params: {
  name: string;
  weight: number;
  inspect: InspectionReportLike | null;
  extras: ExtrasResolved;
  matched: InspectIssueLike[];
}): DimensionScore {
  const { name, weight, inspect, extras, matched } = params;
  // quality 维用 S1+S2 口径（规则聚合 + 单规则封顶 + ESLOC 密度归一化）；
  // security/dependencies 保持原线性扣分（各自另有 secrets/deps 绝对扣分上限）。
  const penalty = name === 'quality' ? qualityPenalty(matched, inspect?.esloc) : penaltyForIssues(matched);
  const issueCount = matched.length;
  const withSecrets = applySecurityPenalty(penalty, issueCount, extras.secrets);
  const withDeps = applyDepsPenalty(withSecrets.penalty, withSecrets.issueCount, extras.deps);
  return {
    name,
    weight,
    score: toDimensionScore(withDeps.penalty),
    issues: withDeps.issueCount,
    status: 'scored',
  };
}

function applySecurityPenalty(
  penalty: number,
  issueCount: number,
  secrets: SecretDataLike | null,
): { penalty: number; issueCount: number } {
  if (!secrets) return { penalty, issueCount };
  return {
    penalty: penalty + secretsPenalty(secrets),
    issueCount: issueCount + secrets.activeCount,
  };
}

function applyDepsPenalty(
  penalty: number,
  issueCount: number,
  deps: DepsDataLike | null,
): { penalty: number; issueCount: number } {
  if (!deps) return { penalty, issueCount };
  return {
    penalty: penalty + depsPenalty(deps),
    issueCount: issueCount + deps.upgradable,
  };
}
