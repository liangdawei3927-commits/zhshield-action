import type {
  SecretDataLike,
  DepsDataLike,
  SentinelDataLike,
  RefactorDataLike,
  PerformanceDataLike,
  GarbageDataLike,
  BackupDataLike,
} from './types';

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
  /** 规则 ID（S1 规则聚合计数用）；缺省时该条 issue 独立计分，行为向后兼容 */
  ruleId?: string;
}

/** inspect 报告最小结构 — 与 @zh/inspect InspectionReport 字段兼容 */
export interface InspectionReportLike {
  issues: InspectIssueLike[];
  /**
   * 项目有效源码规模（ESLOC，S2 密度归一化分母）。
   * 缺省/非法值 → 密度因子 = 1（不稀释不满分，向后兼容）。
   */
  esloc?: number;
}

/**
 * S1 单规则扣分封顶（章程修正①）：同 ruleId 的 issue 聚合后，
 * 一条规则在 quality 维最多贡献的扣分。计数从「逐处命中」改为「按规则聚合」。
 */
export const RULE_PENALTY_CAP = 20;

/**
 * 无 ruleId 的 issue 汇总桶的单桶封顶（P2-4 口径补齐，2026-10-02）。
 * 原实现把 untagged 直接线性累加进 penalty（`let penalty = untagged`），
 * 13 条无 ruleId 的 error（13×8=104）即触底 0 —— 而无 ruleId 恰恰是
 * 最常见形态（外部工具产出的 issue 多不带 ruleId），故该路径最易触发分辨率归零。
 */
export const UNTAGGED_PENALTY_CAP = 40;

/** S2 密度归一化（章程修正②）：项目 ESLOC 达到该值时密度因子 = 1，超过则按比例稀释 */
export const DENSITY_REF_ESLOC = 20_000;

const ISSUE_PENALTY: Record<'error' | 'warning' | 'info', number> = {
  error: 8,
  warning: 4,
  info: 1,
};

/**
 * 各 severity 单级最大贡献（P2-5 口径修正，2026-10-02）。
 *
 * 与 PERFORMANCE_SEVERITY_CAP / REFACTOR_SEVERITY_CAP / GARBAGE_TYPE_CAP 同构：
 * Σ = 100 对齐全局上限。原硬封顶路径已替换为 {@link softBand} 软饱和（cap 为渐近上界），
 * 单级扣分随 count 严格递增，保留高量级下的区分度与「修复有回升」的反馈。
 */
export const ISSUE_SEVERITY_CAP: Readonly<Record<'error' | 'warning' | 'info', number>> = {
  error: 48,
  warning: 40,
  info: 12,
};

/** 全部 issue 级 severity 的稳定遍历序（封顶表与累加共用，避免两处漏键） */
const ISSUE_SEVERITY_KEYS = ['error', 'warning', 'info'] as const;

/**
 * 落盘的 issue 来自旧版本快照或被外部改写，severity 未必落在受支持的三档内。
 * 直接索引命中未知键得到 undefined，求和后整条链路污染为 NaN，而
 * `Math.max(0, NaN) === NaN` —— 分数环直接空白。未知 severity 归入 info 档：
 * 既不虚增严重度，也不让这条 issue 从统计里凭空消失（漏计风险比误报更危险）。
 * 返回收敛后的键，使下游 `ISSUE_PENALTY[key]` 保持类型安全、无需断言。
 */
function normalizeIssueSeverity(severity: string): keyof typeof ISSUE_PENALTY {
  return severity in ISSUE_PENALTY ? (severity as keyof typeof ISSUE_PENALTY) : 'info';
}

export function penaltyForIssues(issues: InspectIssueLike[]): number {
  const counts = new Map<keyof typeof ISSUE_PENALTY, number>();
  for (const issue of issues) {
    const key = normalizeIssueSeverity(issue.severity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let sum = 0;
  for (const key of ISSUE_SEVERITY_KEYS) {
    sum += softBand(counts.get(key) ?? 0, ISSUE_PENALTY[key], ISSUE_SEVERITY_CAP[key]);
  }
  return Math.min(100, sum);
}

/**
 * quality 维扣分（S1 规则聚合 + S2 密度归一化，章程修正①/②）：
 * - 同 ruleId 的 issue 聚合计数，单规则扣分封顶 RULE_PENALTY_CAP；
 *   无 ruleId 的 issue 各自独立（单条 ≤8，恒低于封顶，行为与线性口径一致）；
 * - 聚合扣分按密度因子稀释：esloc ≥ DENSITY_REF_ESLOC 时因子 = REF/esloc，
 *   esloc 缺失/非法/小于 REF 时因子 = 1（不放大，向后兼容）。
 */
export function qualityPenalty(issues: InspectIssueLike[], esloc: number | undefined): number {
  const byRule = new Map<string, number>();
  let untagged = 0;
  for (const issue of issues) {
    const p = ISSUE_PENALTY[normalizeIssueSeverity(issue.severity)];
    if (issue.ruleId) {
      byRule.set(issue.ruleId, (byRule.get(issue.ruleId) ?? 0) + p);
    } else {
      untagged += p;
    }
  }
  let penalty = Math.min(untagged, UNTAGGED_PENALTY_CAP);
  for (const raw of byRule.values()) penalty += Math.min(raw, RULE_PENALTY_CAP);
  const density =
    typeof esloc === 'number' && Number.isFinite(esloc) && esloc > 0
      ? Math.min(1, DENSITY_REF_ESLOC / esloc)
      : 1;
  return penalty * density;
}

/** gate 各级结果单级最大贡献（P2-5 口径修正，2026-10-02；Σ = 100 对齐全局上限） */
export const GUARD_SEVERITY_CAP: Readonly<Record<'blocking' | 'warning', number>> = {
  blocking: 60,
  warning: 40,
};

/** guard 失败/警告计入 gate 维度的扣分（单级贡献走 softBand 软饱和，理由同 ISSUE_SEVERITY_CAP） */
export function guardPenalty(results: GuardCheckLike[]): number {
  let blocking = 0;
  let warning = 0;
  for (const r of results) {
    if (r.status === 'failed' || r.status === 'error' || r.blocking) blocking += 1;
    else if (r.status === 'warning') warning += 1;
  }
  return Math.min(100, softBand(blocking, 8, GUARD_SEVERITY_CAP.blocking) + softBand(warning, 4, GUARD_SEVERITY_CAP.warning));
}

/** guard 中非 passed 的结果数（与 guardPenalty 的判定口径一致） */
export function guardIssueCount(results: GuardCheckLike[]): number {
  return results.reduce((sum, r) => sum + (r.status === 'passed' && !r.blocking ? 0 : 1), 0);
}

/** secrets 扣分：active 未处理每条 -15，上限 60（spec D） */
export function secretsPenalty(secrets: SecretDataLike): number {
  return Math.min(60, secrets.activeCount * 15);
}

/** deps 扣分：漏洞按 critical -12 / high -8 / medium -4，上限 100（spec D） */
export function depsPenalty(deps: DepsDataLike): number {
  return Math.min(
    100,
    deps.vulnerabilities.critical * 12 + deps.vulnerabilities.high * 8 + deps.vulnerabilities.medium * 4,
  );
}

/** sentinel 各级事件单级最大贡献（P2-5 口径修正，2026-10-02；Σ = 100 对齐全局上限） */
export const SENTINEL_SEVERITY_CAP: Readonly<Record<'critical' | 'warning', number>> = {
  critical: 60,
  warning: 40,
};

/** sentinel 扣分（十域评分章程 #9，哨兵独立成维；单级贡献走 softBand 软饱和，理由同 ISSUE_SEVERITY_CAP） */
export function sentinelPenalty(sentinel: SentinelDataLike): number {
  return Math.min(
    100,
    softBand(sentinel.criticalEvents, 10, SENTINEL_SEVERITY_CAP.critical) +
      softBand(sentinel.warningEvents, 5, SENTINEL_SEVERITY_CAP.warning),
  );
}

/**
 * garbage 扣分：按类型单条计权（build-artifact 1 / unused-file 2 / duplicate-code 3 /
 * dead-code 4 / unused-dependency 6），单类型贡献走 {@link softBand} 软饱和，整体上限 100
 * （章程 #5，P2-5 全维度统一）。
 *
 * P2-5 口径修正（替代原 min(cap, weight·n) 硬封顶）：硬封顶下各级一旦越过
 * 半饱和点即恒定封顶，单级扣分随 count 严格递增，保留高量级下的区分度与「修复有回升」的反馈。
 * cap 为渐近上界，永不触底 0。
 */
export const GARBAGE_TYPE_PENALTY: Readonly<Record<string, number>> = {
  'build-artifact': 1,
  'unused-file': 2,
  'duplicate-code': 3,
  'dead-code': 4,
  'unused-dependency': 6,
};

/** garbage 各类型的单类型最大贡献（P2-3 调参点；Σ = 100 与全局上限对齐） */
export const GARBAGE_TYPE_CAP: Readonly<Record<string, number>> = {
  'build-artifact': 10,
  'unused-file': 15,
  'duplicate-code': 20,
  'dead-code': 25,
  'unused-dependency': 30,
};

/** 未知垃圾类型的缺省单条罚分与其贡献封顶 */
export const GARBAGE_UNKNOWN_PENALTY = 2;
export const GARBAGE_UNKNOWN_CAP = 10;

export function garbagePenalty(garbage: GarbageDataLike): number {
  let sum = 0;
  for (const [type, count] of Object.entries(garbage.byType)) {
    const unit = GARBAGE_TYPE_PENALTY[type] ?? GARBAGE_UNKNOWN_PENALTY;
    const cap = GARBAGE_TYPE_CAP[type] ?? GARBAGE_UNKNOWN_CAP;
    sum += softBand(count, unit, cap);
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

/**
 * refactor 扣分：smell 按 error 8 / warning 4 / info 1 计权，单级贡献封顶
 * REFACTOR_SEVERITY_CAP，整体上限 100（章程 #8，2026-09-22 P2-3 初校）。
 *
 * 初校背景：旧口径线性逐项扣分 + 全局 100 上限，真实项目（18 个 AST 规则检出 400+
 * 异味）加权罚分立即触顶 → 该维退化为二元（0/100）且几乎恒为 0。单级封顶保证某一级
 * 异味堆积再多也不独占整维，保留区分度；Σ 三级封顶恰好 100，与全局上限对齐（触底不为负）。
 */
export const REFACTOR_SEVERITY_PENALTY: Readonly<Record<'error' | 'warning' | 'info', number>> = {
  error: 8,
  warning: 4,
  info: 1,
};

/**
 * refactor 各级 severity 的单级最大贡献（P2-4 修正单调性，2026-10-02；Σ = 100 与全局上限对齐）。
 *
 * 原值 error 40 / warning 48 —— 低severity 的封顶反而高于高 severity，
 * 12 条 warning（48）比 5 条 error（40）先把该级打满，分辨率在最高两档之间倒挂。
 * 改为 error 48 / warning 40 / info 12：封顶随 severity 单调递减，Σ 仍为 100。
 */
export const REFACTOR_SEVERITY_CAP: Readonly<Record<'error' | 'warning' | 'info', number>> = {
  error: 48,
  warning: 40,
  info: 12,
};

/**
 * 单级“软饱和”扣分（P2-5 口径修正）：cap·n/(n+K)，K = cap/weight（半饱和点）。
 * 严格递增、上界为 cap，替代原 min(cap, n*weight) 硬封顶——
 * 硬封顶下 warning≥10 即恒扣 40，10 条与 1000 条同分，删坏味道分数不动；
 * 软饱和下单级扣分随 count 持续上升（渐近于 cap），分数永不被钉死。
 * 初始斜率在 n→0 时等于 weight（与原逐项口径连续）。
 */
function softBand(count: number, weight: number, cap: number): number {
  if (cap <= 0) return 0;
  const burden = count * weight;
  return burden / (1 + burden / cap);
}

/**
 * refactor 扣分：smell 按 error 8 / warning 4 / info 1 计权，单级贡献走
 * {@link softBand} 软饱和（cap·n/(n+K)）后叠加，整体上限 100（章程 #8）。
 *
 * P2-5 口径修正（替代原 min(cap, weight·n) 硬封顶）：硬封顶下各级一旦越过
 * 半饱和点即恒定封顶——warning≥10 恒扣 40、info≥12 恒扣 12，于是任何 ≥10 条
 * warning 的仓库都恰好扣 48，10 条与 1000 条同分、清理坏味道分数毫无变化。
 * 软饱和以 REFACTOR_SEVERITY_CAP 为渐近上界（fixture 越大越逼近但永不达到），
 * 单级扣分随 count 严格递增，保留高量级下的区分度与「修复有回升」的反馈。
 */
export function refactorPenalty(refactor: RefactorDataLike): number {
  const keys = ['error', 'warning', 'info'] as const;
  let sum = 0;
  for (const key of keys) {
    sum += softBand(refactor.bySeverity[key], REFACTOR_SEVERITY_PENALTY[key], REFACTOR_SEVERITY_CAP[key]);
  }
  return Math.min(100, sum);
}

/**
 * performance 扣分：critical 8 / high 4 / medium 2 / low 1 / info 0，单级贡献走
 * {@link softBand} 软饱和（cap·n/(n+K)）后叠加，整体上限 100（章程 P2-5 全维度统一）。
 *
 * P2-5 口径修正（替代原 min(cap, weight·n) 硬封顶）：硬封顶下各级一旦越过
 * 半饱和点即恒定封顶，单级扣分随 count 严格递增，保留高量级下的区分度与「修复有回升」的反馈。
 * cap 为渐近上界，永不触底 0。
 */
export const PERFORMANCE_SEVERITY_PENALTY: Readonly<
  Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>
> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
  info: 0,
};

/** performance 各级 severity 的单级最大贡献（P2-3 调参点；Σ = 100 与全局上限对齐） */
export const PERFORMANCE_SEVERITY_CAP: Readonly<
  Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>
> = {
  critical: 40,
  high: 40,
  medium: 15,
  low: 5,
  info: 0,
};

export function performancePenalty(performance: PerformanceDataLike): number {
  const keys = ['critical', 'high', 'medium', 'low', 'info'] as const;
  let sum = 0;
  for (const key of keys) {
    sum += softBand(performance.bySeverity[key], PERFORMANCE_SEVERITY_PENALTY[key], PERFORMANCE_SEVERITY_CAP[key]);
  }
  return Math.min(100, sum);
}
