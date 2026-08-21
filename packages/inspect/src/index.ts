// @zh/inspect - 巡检引擎模块
export const VERSION = '0.1.0';
export { InspectEngine } from './engine';
export { AdapterRunner } from './adapter-runner';
export {
  ESLintAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
} from './adapters';
export type { InspectionReport, AdapterResult, Issue, RunContext } from './types';
