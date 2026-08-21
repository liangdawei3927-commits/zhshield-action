// @zh/security - 安全防护模块
export const VERSION = '0.1.0';
export { VulnerabilityScanner } from './vulnerability-scanner';
export { scanGarbage, cleanGarbage, restoreGarbage } from './garbage-scanner';
export { MalwareScanner } from './malware-scanner';
export { scanNpmThreats } from './npm-threat-scanner';
export { scanPypiThreats } from './pypi-threat-scanner';
export { SecurityEngine } from './engine';
export { SecretLifecycleManager, InMemorySecretStore, FileSecretStore } from './secrets/lifecycle';
export type { SecretStore } from './secrets/lifecycle';
export {
  hashSecret,
  maskSecret,
  mapRuleToType,
  classifySeverity,
  sortFindings,
  parseRemoteHost,
  isPublicRemoteUrl,
} from './secrets/lifecycle';
export type {
  SecretType,
  SecretSeverity,
  SecretStatus,
  SecretLocation,
  SecretFinding,
  SecretScanReport,
  SecretStateRecord,
  SecretPersistState,
  CommandRunner,
} from './secrets/types';
export { SemgrepAdapter, TrivyAdapter, GrypeAdapter, ORTAdapter, DepcheckAdapter } from './adapters';
export { GrypeCrossValidator } from './cross-validator';
export type { CrossConfidence, CrossValidationEntry, CrossValidationReport } from './cross-validator';
export type { Vulnerability, GarbageItem, MalwareItem, SecurityScanReport, GarbageCleanResult, GarbageRestoreResult } from './types';
