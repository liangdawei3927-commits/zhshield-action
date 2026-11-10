// @zh/pipeline — 核心流水线编排器
export const VERSION = '0.1.0';
export { PipelineRunner } from './pipeline-runner';
// 域快照 schema 与只读消费入口（《07》A6）：CLI / 桌面端共用同一口径
export {
  domainSnapshotPath,
  readDomainSnapshot,
  readDiagnosticsFile,
  loadGuardConclusions,
  isDiagnosticsReport,
} from './domain-snapshot';
export type {
  DiagnosticSeverity,
  DiagnosticEntry,
  LspDiagnostic,
  FileDiagnostics,
  DomainDimensionScore,
  DiagnosticsReport,
  DiagnosticSource,
  RuleCoverage,
} from './domain-snapshot';
// 执行层骨架（《07》§7.2）：FileIndex → ToolExecutor → Router
export * from './execution';
// 按域建任务的无头驱动（《07》§7.4 / C5 / A14）：桌面端、CLI、无头脚本共用
export * from './domains';
export { createReport } from './types';
export type { PipelineReport } from './types';
export { detectProjectProfile, resolveEffectiveProjectRoot } from './project-profile';
export type { ProjectProfile, ProjectLanguage, PackageManager } from './project-profile';
export { createRuleMetricsProvider } from './rule-metrics';
export type { RuleMetricsOptions } from './rule-metrics';
export {
  createGateMetricResolver,
  readProjectCoveragePct,
  DEFAULT_COVERAGE_REPORTS,
} from './gate-metrics';
export type { GateMetricInputs } from './gate-metrics';
export {
  computeDiffCoverage,
  parseLcov,
  parseCoverageFinal,
  parseUnifiedDiffHunks,
  readLineCoverage,
  resolveCoverageBase,
  DEFAULT_DIFF_COVERAGE_REPORTS,
} from './gate-coverage-diff';
export type { DiffCoverageResult, LineCoverage, ChangedLines } from './gate-coverage-diff';
// 门禁判定的对外口径由 pipeline 转出：调用方（CLI/桌面端）不必直接依赖 kernel，
// 避免「谁能算分」这件事散落到各消费方。
export { formatGateItems } from '@zh/kernel';
export type { PostScanGateReport, GateItem } from '@zh/kernel';
