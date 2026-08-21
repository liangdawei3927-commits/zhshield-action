// @zh/guard - 门禁模块
export const VERSION = '0.1.0';
export { GuardEngine } from './engine';
export { AdapterRegistry } from './adapter-registry';
export { ConfigLoader } from './config-loader';
export { ResultNormalizer } from './result-normalizer';
export { HooksInstaller } from './hooks-installer';
export { WhitelistManager } from './whitelist-manager';
export { GuardToolAdapterWrapper } from './guard-tool-adapter';
export { FileSecretStateLookup } from './file-secret-state-lookup';
export {
  GuardESLintCheckAdapter,
  GuardSensitiveInfoAdapter,
  ArchitectureBoundaryAdapter,
  TestRunnerAdapter,
  SecurityScanAdapter,
} from './adapters';
export type { CheckResult, CheckOptions, GuardReport, CheckConfig, Adapter } from './types';
export {
  guardReportsPath,
  deriveRiskLevel,
  toGuardReportRecord,
  appendGuardReport,
  listGuardReports,
} from './guard-report-store';
export type { GuardReportRecord } from './guard-report-store';
