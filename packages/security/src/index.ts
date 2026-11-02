// @zh/security - 安全防护模块
export const VERSION = '0.1.0';
export { VulnerabilityScanner } from './vulnerability-scanner';
export { MalwareScanner } from './malware-scanner';
export { SecurityEngine } from './engine';
export {
  SemgrepAdapter,
  TrivyAdapter,
  GrypeAdapter,
  ORTAdapter,
  DepcheckAdapter,
} from './adapters';
export { GrypeCrossValidator } from './cross-validator';
export type {
  CrossConfidence,
  CrossValidationEntry,
  CrossValidationReport,
} from './cross-validator';
export type { Vulnerability, MalwareItem, SecurityScanReport } from './types';
// 安全评分：域执行器合并 SOP 通道结论后需重算（否则合并前的分数被沿用，
// 会出现「检出 1 条漏洞却仍显示 100 分」）。
export { calculateSecurityScore } from './types';
export type { SecretStore } from './secrets/lifecycle';
export {
  SecretLifecycleManager,
  FileSecretStore,
  InMemorySecretStore,
  hashSecret,
  maskSecret,
  mapRuleToType,
  classifySeverity,
  sortFindings,
  parseRemoteHost,
  isPublicRemoteUrl,
} from './secrets/lifecycle';
export { SupplyChainScanScheduler } from './supply-chain-scheduler';
export type { SupplyChainScanOptions } from './supply-chain-scheduler';
export { SecurityCheckEngine } from './security-check-engine';
export type { SecurityCheckResult } from './security-check-engine';
