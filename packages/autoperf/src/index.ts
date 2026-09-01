// @zh/autoperf - 性能自治引擎
export const VERSION = '0.1.0';

export { AutoPerfEngine } from './engine';
export type { AutoPerfEngineDeps } from './engine';
export {
  loadPerfBudgets,
  DEFAULT_BUDGETS,
  defaultBudgetFilePath,
  calibrateBudgets,
} from './budgets';
export { AutoPerfToolAdapter } from './adapter';
export { recordPerfExperience } from './evolve-hook';

export type { PerfProbeResult, PerfBudget, AutoPerfReport, Issue, IssueSeverity } from './types';
