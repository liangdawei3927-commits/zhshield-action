// @zh/scoring - 健康评分模块
export const VERSION = '0.1.0';
export { ScoringEngine } from './engine';
export { ScoringEngine as ContextScoringEngine } from './scoring-engine';
export { DimensionMapper } from './dimension-mapper';
export { getDefaultScoringConfig, getDimensionConfig, getDimensionIds } from './scoring-config';
export type { HealthScore, DimensionScore, ScoreTrend } from './types';
export type {
  PositiveRule,
  PenaltyConfig,
  DimensionDefinition,
  ScoringRuleContext,
  ScoringConfig,
  ScoringResult,
  DimensionScoreDetail,
} from './types';
export * from './pipeline-score';
export * from './tech-debt/dashboard';
export * from './tech-debt/types';
