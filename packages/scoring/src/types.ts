export type ScoreGrade = 'A' | 'B' | 'C' | 'D';
export type ScoreTrend = 'improving' | 'stable' | 'declining';

/** 维度评分状态：scored=已检测并参与加权；not-run=该域从未运行，不参与加权 */
export type DimensionStatus = 'scored' | 'not-run';

export interface DimensionScore {
  name: string;
  weight: number;
  score: number;
  issues: number;
  /** 缺省 'scored'（旧字段保持兼容）；not-run 维度保留在返回数组但不参与 overall 加权 */
  status?: DimensionStatus;
}

/** secrets 域数据（secrets-state.json 子集）：active 为未处理密钥数 */
export interface SecretDataLike {
  activeCount: number;
}

/** deps 域数据：漏洞按 severity 计权，upgradable 仅作展示不重扣 */
export interface DepsDataLike {
  vulnerabilities: { critical: number; high: number; medium: number };
  upgradable: number;
}

/** techdebt 域数据：debtIndex 由 computeDebtIndex 全量 issues 计算（0-100） */
export interface TechDebtDataLike {
  debtIndex: number;
  issueCount: number;
}

/** sentinel 域数据：哨兵运行状态与告警事件数 */
export interface SentinelDataLike {
  active: boolean;
  criticalEvents: number;
  warningEvents: number;
}

/** refactor 域数据：重构报告摘要，按 severity 计权 */
export interface RefactorDataLike {
  totalSmells: number;
  bySeverity: { error: number; warning: number; info: number };
}

/** performance 域数据：性能报告摘要，按 5 级 severity 计权 */
export interface PerformanceDataLike {
  total: number;
  bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
}

/** garbage 域数据：垃圾扫描摘要，按类型计权扣分（十域评分章程 #5） */
export interface GarbageDataLike {
  total: number;
  /** 类型 → 条目数：build-artifact / unused-file / duplicate-code / dead-code / unused-dependency */
  byType: Record<string, number>;
}

/** backup 域数据：备份健康度（状态守护型，非扣分制；十域评分章程 #10） */
export interface BackupDataLike {
  /** 最近一次成功备份时间（ISO）；null = 从未成功备份 */
  lastSuccessAt: string | null;
  /** 最近 ≤10 条备份记录的 overallStatus（新→旧）：success / partial / failed */
  recentStatuses: string[];
  /** 是否启用了定时备份 */
  scheduleEnabled: boolean;
}

/**
 * 扩展域数据（buildHealthDimensions 第 5 参）。
 * 各域 null = 该域从未运行 → 对应维度 not-run（禁止按满分计，spec C）。
 * sentinel 为 null/undefined = 哨兵未激活（gate 维仅由 guard 结果计分，哨兵分独立成维）。
 * refactor/performance 与 deps/techdebt/secrets 同语义：null = 该域从未运行 → not-run。
 * garbage：垃圾清理从未扫描 → not-run。backup：从未备份且未启用定时备份 → not-run。
 */
export interface DimensionExtras {
  secrets?: SecretDataLike | null;
  deps?: DepsDataLike | null;
  techdebt?: TechDebtDataLike | null;
  sentinel?: SentinelDataLike | null;
  refactor?: RefactorDataLike | null;
  performance?: PerformanceDataLike | null;
  garbage?: GarbageDataLike | null;
  backup?: BackupDataLike | null;
}

/** 红线封顶原因（结构化，渲染层负责本地化文案；十域评分章程：critical 一票压制） */
export interface RedLineReason {
  /** 触发红线事实的域：security / dependencies / sentinel */
  domain: 'security' | 'dependencies' | 'sentinel';
  /** 事实种类：活跃密钥未处理 / critical 依赖漏洞 / critical 哨兵事件 */
  kind: 'activeSecrets' | 'criticalVulns' | 'criticalEvents';
  /** 事实数量 */
  count: number;
}

/** 红线封顶信息：任一 critical 事实存在时总评封顶（默认 ≤60） */
export interface RedLineInfo {
  capped: boolean;
  /** 封顶上限（当前固定 60） */
  cap: number;
  reasons: RedLineReason[];
}

export interface HealthScore {
  projectId: string;
  timestamp: Date;
  overall: number;
  grade: ScoreGrade;
  dimensions: DimensionScore[];
  trend: ScoreTrend;
  /** 评分算法版本（scoreVersion 2 = 十域聚合 + 红线封顶）；跨版本分数不做直接对比 */
  scoreVersion?: number;
  /** 红线封顶信息：仅本次汇总存在 critical 事实时有值 */
  redLine?: RedLineInfo;
}

export interface DimensionTrend {
  name: string;
  current: number;
  trend: ScoreTrend;
  slope: number;
}

export interface TrendReport {
  projectId: string;
  current: HealthScore | null;
  overallTrend: ScoreTrend;
  velocity: number;
  acceleration: number;
  volatility: number;
  projectedScore: number | null;
  dimensionTrends: DimensionTrend[];
  insights: string[];
  streak: { direction: ScoreTrend; count: number };
}

export interface ScoringRuleContext {
  findings: Array<{ severity: string; category: string }>;
  metrics: {
    dependencyCount: number;
    testCoverage?: number;
    circularDependencies: number;
    totalFiles: number;
    documentationCoverage?: number;
  };
}

export interface PenaltyConfig {
  dimension: string;
  maxPenalty: number;
  perIssuePenalty: number;
  severityMultipliers: Record<string, number>;
}

export interface PositiveRule {
  id: string;
  name: string;
  description: string;
  dimension: string;
  points: number;
  condition: (ctx: ScoringRuleContext) => boolean;
}

export interface DimensionDefinition {
  id: string;
  name: string;
  weight: number;
  description: string;
  penalties: PenaltyConfig;
  positiveRules: PositiveRule[];
}

export interface ScoringConfig {
  version: string;
  lastUpdated: Date;
  dimensions: DimensionDefinition[];
}

export interface DimensionScoreDetail {
  dimension: string;
  score: number;
  weight: number;
  positive: number;
  negative: number;
  issues: number;
}

export interface ScoringResult {
  overall: number;
  grade: ScoreGrade;
  dimensions: DimensionScore[];
  positivePoints: number;
  negativePoints: number;
  details: DimensionScoreDetail[];
}
