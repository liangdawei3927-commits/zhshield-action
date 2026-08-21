// @zh/scoring - 健康评分模块
export const VERSION = '0.1.0';
export { ScoringEngine } from './engine';
export type { HealthScore, DimensionScore, ScoreTrend } from './types';
export * from './pipeline-score';
export * from './tech-debt/dashboard';
export * from './tech-debt/types';
