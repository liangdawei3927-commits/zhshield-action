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
