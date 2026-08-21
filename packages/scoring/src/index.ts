// @zh/scoring - 健康评分模块
export const VERSION = '0.1.0';
export { ScoringEngine } from './engine';
export { buildHealthDimensions } from './pipeline-score';
export { buildTechDebtDashboard, computeDebtIndex, mapToDebtCategory, moduleOf, mergeActionStatuses, computeTrendDelta } from './tech-debt/dashboard';
export type {
  TechDebtSnapshot,
  TechDebtInput,
  TechDebtTrend,
  ModuleDebt,
  CategoryDebt,
  DebtAction,
  DebtActionStatus,
  DebtCategory,
  DebtIssueInput,
  ModuleHotnessInput,
} from './tech-debt/types';
export type { GuardReportLike, InspectionReportLike } from './pipeline-score';
export type { HealthScore, DimensionScore, ScoreTrend } from './types';
