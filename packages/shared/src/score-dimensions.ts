/** 健康评分维度 */
export type HealthScoreDimension =
  | 'quality'
  | 'gate'
  | 'security'
  | 'dependencies'
  | 'techdebt'
  | 'refactor'
  | 'performance'
  | 'sentinel'
  | 'garbage'
  | 'backup';

export const HEALTH_SCORE_DIMENSIONS: readonly HealthScoreDimension[] = [
  'quality',
  'gate',
  'security',
  'dependencies',
  'techdebt',
  'refactor',
  'performance',
  'sentinel',
  'garbage',
  'backup',
] as const;

/** 评分维度 */
export type ScoreDimension = HealthScoreDimension;
export const SCORE_DIMENSIONS = HEALTH_SCORE_DIMENSIONS;

/**
 * 参考维度：产出分数用于展示/看板，但**不参与总分、覆盖度与等级**。
 *
 * `techdebt` 的 `debtIndex` 由其他域的问题清单重算（同一事实已在
 * quality/security/dependencies 扣过分），计入总分即重复计分，违反
 * 《十域职责边界与独立性契约》C2。保留卡片与页面，只作为债务规模/ROI 参考。
 *
 * 新增参考维度时必须同步 `SCORED_DIMENSIONS` 与总分覆盖口径，否则
 * 「总分 = 各计分类贡献之和」会在无人察觉时漂移。
 */
export const REFERENCE_DIMENSIONS: readonly HealthScoreDimension[] = ['techdebt'] as const;

/** 计分维度：参与总分/覆盖度/等级的 9 个维度（10 张卡去掉参考维度） */
export const SCORED_DIMENSIONS: readonly HealthScoreDimension[] = [
  'quality',
  'gate',
  'security',
  'dependencies',
  'refactor',
  'performance',
  'sentinel',
  'garbage',
  'backup',
] as const;

export function isScoreDimension(value: unknown): value is ScoreDimension {
  return typeof value === 'string' && (SCORE_DIMENSIONS as readonly string[]).includes(value);
}

/** true = 该维度是参考维度（不参与总分/覆盖度/等级） */
export function isReferenceDimension(value: unknown): value is ScoreDimension {
  return (
    typeof value === 'string' && (REFERENCE_DIMENSIONS as readonly string[]).includes(value)
  );
}

/** true = 该维度参与总分（计分维度） */
export function isScoredDimension(value: unknown): value is ScoreDimension {
  return (
    typeof value === 'string' && (SCORED_DIMENSIONS as readonly string[]).includes(value)
  );
}

/**
 * 规则级覆盖（R6）：某计分维本轮的规则执行率。
 *
 * `run` = 已求值规则数（含 not-applicable），`total` = 计划规则数。
 * `complete=false` 表示本维内部有规则没跑：分数只是「已检测部分均分」，
 * 不出等级；总分 `complete` 随之为 false（契约 C4）。
 *
 * 唯一的类型定义：pipeline 快照、评分维度、主进程返回值与渲染层共用，
 * 不允许各写一份内联对象（会漂移成三套口径）。
 */
export interface DimensionCoverage {
  run: number;
  total: number;
  complete: boolean;
}
