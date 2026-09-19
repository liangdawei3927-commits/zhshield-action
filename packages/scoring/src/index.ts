// @zh/scoring - 健康评分模块
export const VERSION = '0.1.0';
export { ScoringEngine } from './engine';
export { ScoringEngine as ContextScoringEngine } from './scoring-engine';
export { DimensionMapper } from './dimension-mapper';
export { computeRedLine, RED_LINE_CAP, SCORE_VERSION } from './redline';
export { getDefaultScoringConfig, getDimensionConfig, getDimensionIds } from './scoring-config';
export {
  findProjectScoringConfigFile,
  parseProjectScoringOverrides,
  validateScoringOverrides,
  mergeScoringOverrides,
  loadProjectScoringConfig,
  resolveScoringConfig,
  PROJECT_SCORING_CONFIG_DIR,
  PROJECT_SCORING_CONFIG_FILENAMES,
  ProjectScoringConfigError,
} from './project-scoring-config';
export {
  resolveProfileScoring,
  applyWeightDeltas,
  applyDisabledDimensions,
} from './profile-scoring-resolver';
export { bucketFindingsByModule, scoreProjectModules, scoreProjectByModules } from './module-score';
export type {
  ModuleScoreInput,
  ModuleGuardInput,
  ModuleInspectInput,
  ModuleScorecard,
  ProjectScoreAggregate,
} from './module-score';
export type { ProfileScoringOverrides } from './profile-scoring-resolver';
export type {
  ScoringOverrides,
  DimensionOverride,
  PenaltyOverride,
  PositiveRuleOverride,
} from './project-scoring-config';
export type {
  HealthScore,
  DimensionScore,
  DimensionStatus,
  SecretDataLike,
  DepsDataLike,
  TechDebtDataLike,
  SentinelDataLike,
  RefactorDataLike,
  PerformanceDataLike,
  GarbageDataLike,
  BackupDataLike,
  RedLineInfo,
  RedLineReason,
  DimensionExtras,
  ScoreTrend,
} from './types';
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
export * from './sop-converters';
export * from './tech-debt/dashboard';
export * from './tech-debt/types';
