import type {
  DimensionScore,
  DimensionExtras,
  SecretDataLike,
  DepsDataLike,
  SentinelDataLike,
  RefactorDataLike,
  PerformanceDataLike,
  GarbageDataLike,
  BackupDataLike,
} from './types';
import { DimensionMapper } from './dimension-mapper';
import type { ScoringProjectProfile } from '@zh/fingerprint';
import {
  resolveProfileScoring,
  applyWeightDeltas,
  applyDisabledDimensions,
} from './profile-scoring-resolver';

/** guard 检查的最小结构 — 与 @zh/guard CheckResult 字段兼容，避免包间依赖 */
export interface GuardCheckLike {
  severity: 'error' | 'warning' | 'info';
  status: 'passed' | 'failed' | 'error' | 'warning';
  blocking: boolean;
}

/** guard 报告最小结构 — 与 @zh/guard GuardReport 字段兼容 */
export interface GuardReportLike {
  results: GuardCheckLike[];
}

/** inspect 问题的最小结构 — 与 @zh/inspect Issue 字段兼容 */
export interface InspectIssueLike {
  severity: 'error' | 'warning' | 'info';
  category: string;
}

/** inspect 报告最小结构 — 与 @zh/inspect InspectionReport 字段兼容 */
export interface InspectionReportLike {
  issues: InspectIssueLike[];
}

/**
 * 维度 → inspect issue.category 映射（十域评分体系，v2）。
 * sentinel/garbage/backup/gate/techdebt/refactor/performance 无 category 映射：
 * 分别由 extras 对应域数据计算。
 */
const DIMENSION_CATEGORIES: Record<string, string[]> = {
  quality: ['performance', 'quality', 'architecture', 'refactoring', 'documentation', 'test'],
  security: ['security'],
  dependencies: ['dependency'],
  refactor: [],
  performance: [],
  techdebt: [],
  gate: [],
  sentinel: [],
  garbage: [],
  backup: [],
};

const ISSUE_PENALTY: Record<'error' | 'warning' | 'info', number> = {
  error: 8,
  warning: 4,
  info: 1,
};

function penaltyForIssues(issues: InspectIssueLike[]): number {
  return issues.reduce((sum, issue) => sum + ISSUE_PENALTY[issue.severity], 0);
}

/** guard 失败/警告计入 gate 维度的扣分 */
function guardPenalty(results: GuardCheckLike[]): number {
  return results.reduce((sum, r) => {
    if (r.status === 'failed' || r.status === 'error' || r.blocking) return sum + 8;
    if (r.status === 'warning') return sum + 4;
    return sum;
  }, 0);
}

/** guard 中非 passed 的结果数（与 guardPenalty 的判定口径一致） */
function guardIssueCount(results: GuardCheckLike[]): number {
  return results.reduce((sum, r) => sum + (r.status === 'passed' && !r.blocking ? 0 : 1), 0);
}

/** secrets 扣分：active 未处理每条 -15，上限 60（spec D） */
function secretsPenalty(secrets: SecretDataLike): number {
  return Math.min(60, secrets.activeCount * 15);
}

/** deps 扣分：漏洞按 critical -12 / high -8 / medium -4，上限 100（spec D） */
function depsPenalty(deps: DepsDataLike): number {
  return Math.min(
    100,
    deps.vulnerabilities.critical * 12 + deps.vulnerabilities.high * 8 + deps.vulnerabilities.medium * 4,
  );
}

/** sentinel 扣分：criticalEvents -10 / warningEvents -5，上限 100（十域评分章程 #9，哨兵独立成维） */
function sentinelPenalty(sentinel: SentinelDataLike): number {
  return Math.min(100, sentinel.criticalEvents * 10 + sentinel.warningEvents * 5);
}

/** garbage 扣分：build-artifact -1 / unused-file -2 / duplicate-code -3 / dead-code -4 / unused-dependency -6，上限 100（章程 #5） */
const GARBAGE_TYPE_PENALTY: Record<string, number> = {
  'build-artifact': 1,
  'unused-file': 2,
  'duplicate-code': 3,
  'dead-code': 4,
  'unused-dependency': 6,
};

function garbagePenalty(garbage: GarbageDataLike): number {
  let sum = 0;
  for (const [type, count] of Object.entries(garbage.byType)) {
    sum += count * (GARBAGE_TYPE_PENALTY[type] ?? 2);
  }
  return Math.min(100, sum);
}

/**
 * backup 健康度扣分（状态守护型，章程 #10）：
 * - 新鲜度：7 天内有成功备份 0 分；7–30 天 -20；超过 30 天或从未成功 -40；
 * - 失败率：最近 ≤10 条记录中 failed/partial 占比 × 30。
 */
export const BACKUP_FRESH_WINDOW_DAYS = 7;
export const BACKUP_STALE_WINDOW_DAYS = 30;
const BACKUP_FRESH_PENALTY = 0;
const BACKUP_STALE_PENALTY = 20;
const BACKUP_NEVER_PENALTY = 40;
const BACKUP_FAILURE_WEIGHT = 30;

export function backupPenalty(backup: BackupDataLike, now: number = Date.now()): number {
  let freshnessPenalty: number;
  if (backup.lastSuccessAt === null) {
    freshnessPenalty = BACKUP_NEVER_PENALTY;
  } else {
    const days = (now - new Date(backup.lastSuccessAt).getTime()) / 86_400_000;
    freshnessPenalty =
      days <= BACKUP_FRESH_WINDOW_DAYS
        ? BACKUP_FRESH_PENALTY
        : days <= BACKUP_STALE_WINDOW_DAYS
          ? BACKUP_STALE_PENALTY
          : BACKUP_NEVER_PENALTY;
  }
  const total = backup.recentStatuses.length;
  const bad = backup.recentStatuses.filter((s) => s === 'failed' || s === 'partial').length;
  const failurePenalty = total > 0 ? (bad / total) * BACKUP_FAILURE_WEIGHT : 0;
  return Math.min(100, freshnessPenalty + failurePenalty);
}

/** refactor 扣分：smell 按 error -8 / warning -4 / info -1，上限 100（spec D） */
function refactorPenalty(refactor: RefactorDataLike): number {
  return Math.min(100, refactor.bySeverity.error * 8 + refactor.bySeverity.warning * 4 + refactor.bySeverity.info * 1);
}

/** performance 扣分：critical -8 / high -4 / medium -2 / low -1 / info 0，上限 100 */
function performancePenalty(performance: PerformanceDataLike): number {
  return Math.min(100, performance.bySeverity.critical * 8 + performance.bySeverity.high * 4 + performance.bySeverity.medium * 2 + performance.bySeverity.low * 1);
}

function notRun(name: string, weight: number): DimensionScore {
  return { name, weight, score: 0, issues: 0, status: 'not-run' };
}

/**
 * 由 guard + inspect + 扩展域数据构建健康维度分（十域评分体系 v2，权重和为 1）。
 * 每个维度满分 100：inspect issues 按 error 扣 8、warning 扣 4、info 扣 1，下限 0；
 * security 额外扣 secrets 活跃密钥；dependencies 额外扣依赖漏洞；techdebt = 100 − debtIndex；
 * refactor 按 smell severity 计权扣分；performance 按 5 级 severity 计权扣分；
 * gate 由 guard 失败/阻塞扣分（v2 起哨兵告警拆出独立 sentinel 维）；
 * sentinel 按事件 critical/warning 计权扣分；garbage 按垃圾类型计权扣分；
 * backup 为状态守护型健康度（新鲜度 + 失败率，见 backupPenalty）。
 *
 * 未检测语义（spec C）：某域从未运行时该域不参与加权且标注 not-run，禁止按满分计。
 * - quality: inspect 为 null → not-run
 * - security: extras.secrets===null 且 inspect 无 security 类 issues → not-run
 * - dependencies: extras.deps===null 且 inspect 无 dependency 类 issues → not-run
 * - techdebt: extras.techdebt===null → not-run
 * - refactor: extras.refactor===null → not-run
 * - performance: extras.performance===null → not-run
 * - gate: guard 为 null → not-run
 *
 * 权重来自项目级评分配置（默认配置 + `.zhshield/scoring.yml` 覆盖，见
 * {@link resolveScoringConfig}）；无覆盖文件时与内置默认权重一致。
 *
 * @param guard guard 报告（可空；null = 门禁未运行）
 * @param inspect inspect 报告（可空；null = 质量巡检未运行）
 * @param projectRoot 项目根目录，缺省为 process.cwd()；传入可显式指定被扫描项目
 * @param profile 项目画像（来自 @zh/fingerprint 的评分契约）；传入时按项目类型自动微调维度权重，
 *   不传则走默认配置（向后兼容）。profile 增量在项目级 .zhshield/scoring.yml 之上叠加。
 * @param extras 扩展域数据（secrets/deps/techdebt/sentinel/refactor/performance）；缺省 = 各域 null = not-run
 * @throws {ProjectScoringConfigError} 项目覆盖文件存在但内容非法时（fail-fast）
 */
export function buildHealthDimensions(
  guard: GuardReportLike | null,
  inspect: InspectionReportLike | null,
  projectRoot?: string,
  profile?: ScoringProjectProfile | null,
  extras?: DimensionExtras,
): DimensionScore[] {
  const dimensionMapper = new DimensionMapper(undefined, projectRoot);
  const weightMap = resolveWeightMap(profile, dimensionMapper);
  const secrets = extras?.secrets ?? null;
  const deps = extras?.deps ?? null;
  const techdebt = extras?.techdebt ?? null;
  const sentinel = extras?.sentinel ?? null;
  const refactor = extras?.refactor ?? null;
  const performance = extras?.performance ?? null;
  const garbage = extras?.garbage ?? null;
  const backup = extras?.backup ?? null;

  return Object.entries(DIMENSION_CATEGORIES).map(([name, categories]) =>
    scoreDimension(name, categories, weightMap, guard, inspect, {
      secrets,
      deps,
      techdebt,
      sentinel,
      refactor,
      performance,
      garbage,
      backup,
    }),
  );
}

/** 画像驱动权重适配：增量叠加 + 不适用维度剔除 + 归一化，向后兼容 */
function resolveWeightMap(
  profile: ScoringProjectProfile | null | undefined,
  dimensionMapper: DimensionMapper,
): Record<string, number> {
  let weightMap = dimensionMapper.getWeightMap();
  if (profile) {
    const overrides = resolveProfileScoring(profile);
    if (overrides.weightDeltas) {
      weightMap = applyWeightDeltas(weightMap, overrides.weightDeltas);
    }
    if (overrides.disabledDimensions?.length) {
      weightMap = applyDisabledDimensions(weightMap, overrides.disabledDimensions);
    }
  }
  return weightMap;
}

interface ExtrasResolved {
  secrets: SecretDataLike | null;
  deps: DepsDataLike | null;
  techdebt: { debtIndex: number; issueCount: number } | null;
  sentinel: SentinelDataLike | null;
  refactor: RefactorDataLike | null;
  performance: PerformanceDataLike | null;
  garbage: GarbageDataLike | null;
  backup: BackupDataLike | null;
}

function scoreDimension(
  name: string,
  categories: string[],
  weightMap: Record<string, number>,
  guard: GuardReportLike | null,
  inspect: InspectionReportLike | null,
  extras: ExtrasResolved,
): DimensionScore {
  const weight = weightMap[name] ?? 0;
  const issues = inspect?.issues ?? [];
  const matched = issues.filter((issue) => categories.includes(issue.category));

  if (name === 'quality' && inspect === null) return notRun(name, weight);
  if (name === 'security' && extras.secrets === null && matched.length === 0) {
    return notRun(name, weight);
  }
  if (name === 'dependencies' && extras.deps === null && matched.length === 0) {
    return notRun(name, weight);
  }
  if (name === 'techdebt' && extras.techdebt === null) return notRun(name, weight);
  if (name === 'refactor' && extras.refactor === null) return notRun(name, weight);
  if (name === 'performance' && extras.performance === null) return notRun(name, weight);
  if (name === 'gate' && guard === null) return notRun(name, weight);
  if (name === 'sentinel' && extras.sentinel === null) return notRun(name, weight);
  if (name === 'garbage' && extras.garbage === null) return notRun(name, weight);
  if (name === 'backup' && extras.backup === null) return notRun(name, weight);

  if (name === 'techdebt') {
    const debtIndex = extras.techdebt!.debtIndex;
    return {
      name,
      weight,
      score: Math.max(0, Math.round((100 - debtIndex) * 10) / 10),
      issues: extras.techdebt!.issueCount,
      status: 'scored',
    };
  }

  if (name === 'refactor') {
    const penalty = refactorPenalty(extras.refactor!);
    return { name, weight, score: Math.max(0, Math.round((100 - penalty) * 10) / 10), issues: extras.refactor!.totalSmells, status: 'scored' };
  }

  if (name === 'performance') {
    const penalty = performancePenalty(extras.performance!);
    return { name, weight, score: Math.max(0, Math.round((100 - penalty) * 10) / 10), issues: extras.performance!.total, status: 'scored' };
  }

  if (name === 'gate') {
    // v2（十域评分章程）：哨兵告警已拆出独立 sentinel 维，gate 只吃 guard 检查结果
    const gPenalty = guard ? guardPenalty(guard.results) : 0;
    const gCount = guard ? guardIssueCount(guard.results) : 0;
    return {
      name,
      weight,
      score: Math.max(0, Math.round((100 - gPenalty) * 10) / 10),
      issues: gCount,
      status: 'scored',
    };
  }

  if (name === 'sentinel') {
    const sPenalty = sentinelPenalty(extras.sentinel!);
    return {
      name,
      weight,
      score: Math.max(0, Math.round((100 - sPenalty) * 10) / 10),
      issues: extras.sentinel!.criticalEvents + extras.sentinel!.warningEvents,
      status: 'scored',
    };
  }

  if (name === 'garbage') {
    const penalty = garbagePenalty(extras.garbage!);
    return {
      name,
      weight,
      score: Math.max(0, Math.round((100 - penalty) * 10) / 10),
      issues: extras.garbage!.total,
      status: 'scored',
    };
  }

  if (name === 'backup') {
    const penalty = backupPenalty(extras.backup!);
    const bad = extras.backup!.recentStatuses.filter(
      (s) => s === 'failed' || s === 'partial',
    ).length;
    return {
      name,
      weight,
      score: Math.max(0, Math.round((100 - penalty) * 10) / 10),
      issues: bad,
      status: 'scored',
    };
  }

  let penalty = penaltyForIssues(matched);
  let issueCount = matched.length;
  if (name === 'security') {
    if (extras.secrets) {
      penalty += secretsPenalty(extras.secrets);
      issueCount += extras.secrets.activeCount;
    }
  }
  if (name === 'dependencies') {
    if (extras.deps) {
      penalty += depsPenalty(extras.deps);
      issueCount += extras.deps.upgradable;
    }
  }

  return {
    name,
    weight,
    score: Math.max(0, Math.round((100 - penalty) * 10) / 10),
    issues: issueCount,
    status: 'scored',
  };
}