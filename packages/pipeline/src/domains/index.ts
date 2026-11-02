/**
 * 按域建任务的统一出口（《07》§7.4 / C5）。
 *
 * 桌面端、CLI、无头脚本都从这里取同一批执行器与同一份账本口径 ——
 * 编排只要出现第二份，A14 的总时长就又变成"各说各话"。
 */
export { runDomains, runDomain, formatDomainRecord, STATIC_SCAN_DOMAINS, SCAN_CHAIN_DOMAINS } from './run-domains';
export {
  DEFAULT_DOMAIN_EXECUTORS,
  RUNTIME_ONLY_DOMAINS,
  runInspectDomain,
  runGuardDomain,
  runSecurityDomain,
  runDepsDomain,
  runGarbageDomain,
  runPerformanceDomain,
  runRefactorDomain,
  scanRefactor,
} from './executors';
export type { RefactorScanResult, PerformanceIssueData } from './executors';
export { scanDeps, applyMismatchedTrust, extractMismatchedNodeIds, integritySnapshot } from './deps-scan';
export { runCveChecks, cveCounts } from './deps-cve';
export type { CveCheckResult, CveFinding, CveQueryableDep } from './deps-cve';
export type {
  DepsScanReport,
  DepsScanResult,
  DepsScanInput,
  DepsCveResult,
  DepsCveFinding,
} from './deps-scan';
export type {
  DomainExecution,
  DomainExecutionContext,
  DomainEvent,
  DomainExecutor,
  DomainRunRecord,
  DomainRunLedger,
  DomainRunOptions,
  PipelineRunnerLike,
} from './types';
