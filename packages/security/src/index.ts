// @zh/security - 安全防护模块
export const VERSION = '0.1.0';
export { VulnerabilityScanner } from './vulnerability-scanner';
export { GarbageScanner } from './garbage-scanner';
export { MalwareScanner } from './malware-scanner';
export { SecurityEngine } from './engine';
export { SemgrepAdapter, TrivyAdapter, GrypeAdapter, ORTAdapter, DepcheckAdapter } from './adapters';
export { GrypeCrossValidator } from './cross-validator';
export type { CrossConfidence, CrossValidationEntry, CrossValidationReport } from './cross-validator';
export type { Vulnerability, GarbageItem, MalwareItem, SecurityScanReport } from './types';
export type { GarbageCleanResult, GarbageRestoreResult } from './types';
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
export { scanGarbage, cleanGarbage, restoreGarbage } from './garbage-scanner';
