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

/**
 * 各 severity 单级最大贡献（P2-4 口径补齐，2026-10-02）。
 *
 * 与 PERFORMANCE_SEVERITY_CAP / REFACTOR_SEVERITY_CAP / GARBAGE_TYPE_CAP 同构：
 * Σ = 100 对齐全局上限。修复前 security/dependencies 走纯线性累加，
 * 13 条 error（13×8=104）即触底 0，其后无论再堆多少条，分数恒为 0 ——
 * 用户改完问题看不到分数回升，失去了「修复有进展」的反馈。
 * 单级封顶后：单级封顶内仍有分辨率，超出后由其余级与 issues 计数继续表达严重度。
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

function penaltyForIssues(issues: InspectIssueLike[]): number {
  const bySeverity = new Map<string, number>();
  for (const issue of issues) {
    const key = normalizeIssueSeverity(issue.severity);
    bySeverity.set(key, (bySeverity.get(key) ?? 0) + ISSUE_PENALTY[key]);
  }
  let sum = 0;
  for (const key of ISSUE_SEVERITY_KEYS) {
    sum += Math.min(ISSUE_SEVERITY_CAP[key], bySeverity.get(key) ?? 0);
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
function qualityPenalty(issues: InspectIssueLike[], esloc: number | undefined): number {
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

/** gate 各级结果单级最大贡献（P2-4 口径补齐，2026-10-02；Σ = 100 对齐全局上限） */
export const GUARD_SEVERITY_CAP: Readonly<Record<'blocking' | 'warning', number>> = {
  blocking: 60,
  warning: 40,
};

/** guard 失败/警告计入 gate 维度的扣分（单级封顶，理由同 ISSUE_SEVERITY_CAP） */
function guardPenalty(results: GuardCheckLike[]): number {
  let blocking = 0;
  let warning = 0;
  for (const r of results) {
    if (r.status === 'failed' || r.status === 'error' || r.blocking) blocking += 1;
    else if (r.status === 'warning') warning += 1;
  }
  return Math.min(100, Math.min(GUARD_SEVERITY_CAP.blocking, blocking * 8) + Math.min(GUARD_SEVERITY_CAP.warning, warning * 4));
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

/** sentinel 各级事件单级最大贡献（P2-4 口径补齐，2026-10-02；Σ = 100 对齐全局上限） */
export const SENTINEL_SEVERITY_CAP: Readonly<Record<'critical' | 'warning', number>> = {
  critical: 60,
  warning: 40,
};

/** sentinel 扣分（十域评分章程 #9，哨兵独立成维；单级封顶，理由同 ISSUE_SEVERITY_CAP） */
function sentinelPenalty(sentinel: SentinelDataLike): number {
  return Math.min(
    100,
    Math.min(SENTINEL_SEVERITY_CAP.critical, sentinel.criticalEvents * 10) +
      Math.min(SENTINEL_SEVERITY_CAP.warning, sentinel.warningEvents * 5),
  );
}

/**
 * garbage 扣分：按类型单条计权（build-artifact 1 / unused-file 2 / duplicate-code 3 /
 * dead-code 4 / unused-dependency 6），单类型贡献封顶 GARBAGE_TYPE_CAP，整体上限 100
 * （章程 #5，2026-09-22 P2-3 初校）。
 *
 * 初校背景：旧口径线性逐项扣分 + 全局 100 上限，真实项目（ts-prune/jscpd 命中数百项）
 * 加权罚分立即触顶 → 该维退化为二元（0/100）且几乎恒为 0。单类型封顶保证某一类垃圾
 * 堆积再多也不独占整维，保留区分度；Σ 各类型封顶恰好 100，与全局上限对齐（触底不为负）。
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

function garbagePenalty(garbage: GarbageDataLike): number {
  let sum = 0;
  for (const [type, count] of Object.entries(garbage.byType)) {
    const unit = GARBAGE_TYPE_PENALTY[type] ?? GARBAGE_UNKNOWN_PENALTY;
    const cap = GARBAGE_TYPE_CAP[type] ?? GARBAGE_UNKNOWN_CAP;
    sum += Math.min(cap, count * unit);
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

function refactorPenalty(refactor: RefactorDataLike): number {
  const keys = ['error', 'warning', 'info'] as const;
  let sum = 0;
  for (const key of keys) {
    sum += Math.min(REFACTOR_SEVERITY_CAP[key], refactor.bySeverity[key] * REFACTOR_SEVERITY_PENALTY[key]);
  }
  return Math.min(100, sum);
}

/**
 * performance 扣分：critical 8 / high 4 / medium 2 / low 1 / info 0，单级贡献封顶
 * PERFORMANCE_SEVERITY_CAP，整体上限 100（2026-09-22 P2-3 同批补校）。
 *
 * 补校背景：performance 与 refactor / garbage 在 2026-09-22 P2-3 同批初校时被漏掉，仍是
 * 裸「线性逐项扣分 + 全局 100 上限」。真实证据：改分前基线实扫 45 条 complexity.sync-io
 * （high）+ 5 条 complexity.nested-loop（medium），加权 45×4 + 5×2 = 190 → 全局触顶 100 →
 * 该维 0 分，即 1% 的问题项对分数零影响、其余 99% 全部不可见（23 条 high 之后分辨率归零）。
 * 单级封顶保证某一级堆积再多也不独占整维；Σ 五级封顶恰好 100，与全局上限对齐（触底不为负）。
 *
 * 注：上述 45/5 是改分前基线，不是当前实扫值。同步 IO 一侧已按运行时上下文修正
 * （Node CLI/批处理/启动期不报），实扫 0 条。嵌套循环一侧原先只数 AST 层数、不看代价结构：
 * 逐条实测 6 条全是线性分层遍历（4 倍输入耗时 2.2~4.0 倍），其中 4 条每层集合都由上一层
 * 那一轮派生、总量等于叶子数。现补「乘数层」判据——某一层既不引用外层循环绑定、也不引用
 * 外层体内的派生量、且遍历的不是固定长度配置集合时才算独立维度——只有存在独立维度才报。
 * 当前实扫 0 条；`input × 固定配置` 形态（如「文件数 × 规则表」）在单文件静态分析里与真实
 * 交叉乘法不可区分，按设计保留告警。本封顶的回归测试不依赖具体条数。
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

function performancePenalty(performance: PerformanceDataLike): number {
  const keys = ['critical', 'high', 'medium', 'low', 'info'] as const;
  let sum = 0;
  for (const key of keys) {
    sum += Math.min(
      PERFORMANCE_SEVERITY_CAP[key],
      performance.bySeverity[key] * PERFORMANCE_SEVERITY_PENALTY[key],
    );
  }
  return Math.min(100, sum);
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
/**
 * buildHealthDimensions 参数对象。
 * @param guard guard 报告（可空；null = 门禁未运行）
 * @param inspect inspect 报告（可空；null = 质量巡检未运行）
 * @param projectRoot 项目根目录，缺省为 process.cwd()；传入可显式指定被扫描项目
 * @param profile 项目画像（来自 @zh/fingerprint 的评分契约）；传入时按项目类型自动微调维度权重，
 *   不传则走默认配置（向后兼容）。profile 增量在项目级 .zhshield/scoring.yml 之上叠加。
 * @param extras 扩展域数据（secrets/deps/techdebt/sentinel/refactor/performance）；缺省 = 各域 null = not-run
 */
export interface BuildHealthDimensionsParams {
  guard: GuardReportLike | null;
  inspect: InspectionReportLike | null;
  projectRoot?: string;
  profile?: ScoringProjectProfile | null;
  extras?: DimensionExtras;
}

export function buildHealthDimensions({
  guard,
  inspect,
  projectRoot,
  profile,
  extras,
}: BuildHealthDimensionsParams): DimensionScore[] {
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
    scoreDimension({
      name,
      categories,
      weightMap,
      guard,
      inspect,
      extras: {
        secrets,
        deps,
        techdebt,
        sentinel,
        refactor,
        performance,
        garbage,
        backup,
      },
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

/** scoreDimension 参数对象 */
interface ScoreDimensionParams {
  name: string;
  categories: string[];
  weightMap: Record<string, number>;
  guard: GuardReportLike | null;
  inspect: InspectionReportLike | null;
  extras: ExtrasResolved;
}

function scoreDimension(params: ScoreDimensionParams): DimensionScore {
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