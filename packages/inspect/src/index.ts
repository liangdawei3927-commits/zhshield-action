// @zh/inspect - 巡检引擎模块
export const VERSION = '0.1.0';
export { InspectEngine } from './engine';
export { SupplyChainManager, LockfileLicenseAuditor, ToolUnavailableError } from './toolchain/supply-chain';
export type { ToolDownloader, DownloadResult, SupplyChainManagerOptions } from './toolchain/supply-chain';
export { AdapterRunner } from './adapter-runner';
export {
  ESLintAdapter,
  TypeScriptAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
} from './adapters';
export type { InspectionReport, AdapterResult, Issue, RunContext } from './types';
export {
  AiCodeReviewImpl,
  HallucinatedDependencyCheckImpl,
  AiOriginDetectorImpl,
  analyzeStyleSignature,
  PATTERN_RULES,
} from './ai-code';
export type {
  AiCodeReview,
  AiCodeVuln,
  AiOriginFinding,
  AiComplianceReport,
  HallucinatedDependencyCheck,
  HallucinatedDependencyFinding,
  AiReviewOptions,
  AiOriginDetectorOptions,
} from './ai-code';
