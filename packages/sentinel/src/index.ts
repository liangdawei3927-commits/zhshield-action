export const VERSION = '0.2.0';

export { EventCenter } from './event-center';
export { subscribeScopeViolations, SCOPE_VIOLATION_EVENT } from './scope-violation-consumer';
export { AlertHandler } from './alert-handler';
export { FileMonitor } from './file-monitor';
export type { FileMonitorConfig, FileChangeType, FileWatchFilter } from './file-monitor';
export { ProcessMonitor } from './process-monitor';
export { isInformationalEvent } from './process-monitor';
export type { ProcessMonitorConfig } from './process-monitor';
export { LogCollector } from './log-collector';
export type { LogCollectorConfig, LogPattern } from './log-collector';
export { AutoFixer } from './auto-fixer';
export type { AutoFixerConfig, AutoFixRule, AutoFixAction } from './auto-fixer';
export { parseRunCommand, detectRunCommand, discoverLogPaths } from './project-probe';
export type { DetectedRunCommand } from './project-probe';
export {
  defaultFileWatchFilter,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_RE,
  isIgnoredPath,
  resolveChangeType,
} from './file-monitor';
export {
  collectStaleEventIds,
  pruneStaleFileEvents,
  readEventFilePath,
  DEFAULT_UNLINK_TTL_MS,
  PRUNE_SCAN_LIMIT,
  PRUNABLE_MODULE,
} from './out-of-scope-prune';
export type { PrunableEventLike, PruneCriteria } from './out-of-scope-prune';
export {
  hasTrackedUnder,
  readGitIndex,
  readGitIndexSync,
  findRepoRootFor,
  GitIndexCache,
} from './git-index';

export type { SentinelEvent, AlertPayload, EventStatus, EventSeverity, EventType } from './types';
