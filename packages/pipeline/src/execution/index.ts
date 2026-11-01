/**
 * 执行层骨架（《07》§7.2 三层结构）的统一出口。
 *
 * Scheduler（按域建任务、域级预算/熔断）在迁移第 8 步接入；
 * 它复用的三层在这里统一出口：FileIndex → ToolExecutor → Router。
 */
export { buildFileIndex, targetsOfKind } from './file-index';
export type { FileTargetKind, FileTarget, FileIndexOptions, FileIndexResult } from './file-index';

export { ToolExecutor, toolInvocationKey } from './tool-executor';
export type { ToolInvocation, ExecuteOnceResult } from './tool-executor';

export { routeFindings } from './router';
export type {
  RoutableFinding,
  UnroutedReason,
  UnroutedFinding,
  DistributionRecord,
  RouteResult,
} from './router';

export { Scheduler } from './scheduler';
export type {
  ToolRequest,
  DomainPlan,
  ToolRunStatus,
  ToolRunRecord,
  DomainRunStatus,
  DomainRunOutcome,
  SchedulerOptions,
  SchedulerResult,
} from './scheduler';
