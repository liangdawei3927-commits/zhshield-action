// @zh/dependency - 依赖管家（Dependency Manager）
export const VERSION = '0.1.0';
export { buildDependencyGraph } from './graph-builder';
export { toCycloneDX } from './sbom';
export { buildLicenseMatrix, classifyLicense, normalizeLicenseId } from './license-matrix';
export {
  TyposquatDetectorImpl,
  KNOWN_PACKAGES,
  COMMON_TARGETS,
  HIGH_RISK_MAX_EDIT_DISTANCE,
  MEDIUM_RISK_MAX_EDIT_DISTANCE,
  LOW_RISK_MAX_EDIT_DISTANCE,
  LOW_RISK_MIN_TARGET_LENGTH,
} from './adapters/typosquat-detector';
export type {
  TyposquatDetector,
  TyposquatFinding,
  TyposquatSignals,
} from './adapters/typosquat-detector';
export { resolveProjectRoot } from './adapters/project-root';
export { LockfileVerifierImpl, lockfileVerifier } from './adapters/lockfile-verifier';
export type {
  LockfileVerifier,
  LockfileVerifierOptions,
  LockfileVerification,
  LockfileDiff,
} from './adapters/lockfile-verifier';
export {
  UpgradeEvaluatorImpl,
  DEFAULT_UPGRADE_CATALOG,
} from './adapters/upgrade-evaluator';
export type {
  UpgradeEvaluator,
  UpgradeAssessment,
  UpgradeCandidate,
  BreakingChange,
  UpgradeEvaluatorOptions,
  CatalogEntry,
  UpgradeCatalog,
} from './adapters/upgrade-evaluator';
export { EnvConsistencyCheckerImpl } from './adapters/env-consistency';
export type {
  EnvConsistencyChecker,
  EnvConsistencyOptions,
  EnvConsistencyReport,
  EnvEntry,
  ProjectProfile,
  ProjectLanguage,
  PackageManager,
} from './adapters/env-consistency';
export { checkOutdated, NpmOutdatedError } from './adapters/npm-outdated';
export type {
  OutdatedDependencyInfo,
  NpmOutdatedErrorCode,
} from './adapters/npm-outdated';
export type { CycloneDXDocument, CycloneDXComponent } from './sbom';
export type { LicenseMatrixReport, LicenseEntry, LicenseCategory, LicenseRisk } from './license-matrix';
export type {
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  Ecosystem,
  LockfileStatus,
  RegistrySource,
  TargetId,
  TrustStatus,
  VulnerabilityRef,
} from './types';
