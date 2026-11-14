// @zh/shared - 所有模块共用的类型定义
export const VERSION = '0.1.0';
export {
  TOOL_IDS,
  GOVERNANCE_DOMAINS,
  INSPECT_SCOPE_DOMAINS,
  ACTION_TYPES,
  DATA_SOURCES,
  RULE_LIFECYCLE_STATUSES,
  EXECUTION_MODES,
  SEVERITIES,
} from './types';
// 跨域单一来源（T8 口径统一）：门禁 与 体检/安全中心 共用同一份规则定义
export {
  CLEAN_ARCH_LAYERS,
  ARCH_LAYER_EXCLUDED_DIRS,
  ARCH_LAYER_EXCLUDE_PATTERNS,
  allowedDependenciesOf,
  isLayerDependencyAllowed,
  type ArchLayer,
} from './arch-layers';
// 检测能力注册表：「宣称什么」与「实现什么」的唯一对照表。
// UI 空态只允许宣称 status='implemented' 的能力；planned / deprecated 由本表集中裁决。
export {
  CAPABILITY_REGISTRY,
  CAPABILITIES_BY_DOMAIN,
  implementedCapabilities,
  unimplementedCapabilities,
  findCapabilitiesWithoutEvidence,
} from './capability-registry';
export type { CapabilityDeclaration, CapabilityStatus } from './capability-registry';
export { SECRET_PATTERNS, toNameRegexPatterns, type SecretPattern } from './secret-patterns';
export type {
  PagedResult,
  ApiErrorDTO,
  ApiResponseEnvelope,
  Issue,
  IssueSeverity,
  IssueCategory,
  IssueSource,
  CodeFlow,
  CodeFlowThreadFlow,
  CodeFlowLocation,
  CheckResult,
  DimensionScore,
  SentinelOccurrence,
  GarbageItem,
  GarbageItemType,
  // Tool integration types
  ToolId,
  ToolCategory,
  ToolPriority,
  ToolInstallMode,
  ToolStatus,
  ToolMeta,
  ToolConfig,
  ToolResult,
  ToolScanOptions,
  ToolAdapter,
  ToolScanBatchRequest,
  AccessScope,
  ToolCallHook,
  ToolVersionInfo,
  ToolErrorLog,
  AuditAction,
  AuditLogEntry,
  AuditEntry,
  WhitelistScope,
  ToolsConfig,
  DegradationLevel,
  ToolOutputMapper,
  ToolMapperRegistry,
  GuardConfig,
  GuardCheckItem,
  HookType,
  BuiltinRule,
  CloudSyncRule,
  CloudSyncConfig,
  GovernanceDomain,
  SopVersion,
  SopDiff,
  SopDiffMetadata,
} from './types';
export { ToolManager } from './tool-manager';
export {
  probeToolVersion,
  invalidateToolProbes,
  setToolProbeTtlMs,
  __resetToolProbeCache,
} from './tool-probe';
export type { ToolProbeResult } from './tool-probe';
export { runToolOnce, withToolRunScope, currentToolRunScope, runOncePerScope } from './tool-run-scope';
export type { ToolRunScope, ToolRunOptions } from './tool-run-scope';
export {
  findLocalToolBin,
  findZhshieldToolBin,
  getZhshieldToolBinDir,
  resolveToolCommand,
  resolveToolCommandDetailed,
} from './tool-resolve';
export type { ToolCommandOrigin, ResolvedToolCommand } from './tool-resolve';
export { BuiltinToolAdapter } from './builtin-tool-adapter';
export { wrapAdapter, evaluateAccessScope } from './tool-adapter-decorator';
export type {
  HookedToolResult,
  ScopeViolation,
  ScopeViolationContext,
  WrapAdapterOptions,
} from './tool-adapter-decorator';
export { matchGlobPath } from './scope-matcher';
export {
  toolMappers,
  eslintMapper,
  semgrepMapper,
  trivyMapper,
  grypeMapper,
  gitleaksMapper,
  depcheckMapper,
  depCruiserMapper,
  jscpdMapper,
} from './output-mappers';
export type {
  EslintFile,
  SemgrepResult,
  SemgrepOutput,
  SemgrepDataflowTrace,
  SemgrepCodeFlow,
  SemgrepThreadFlow,
  SemgrepFlowLocation,
  TrivyVulnerability,
  TrivySecret,
  TrivyResult,
  TrivyOutput,
  GrypeMatch,
  GrypeOutput,
  GitleaksFinding,
  DepcheckOutput,
  DepCruiserViolation,
  DepCruiserOutput,
  JscpdDuplicate,
  JscpdOutput,
} from './output-mappers';
export { DegradationManager } from './degradation-manager';
export {
  isToolInScope,
  isToolLanguagesMatch,
  filterToolsByProfile,
  SERVER_TOOL_IDS,
} from './tool-scope';
export type { ScopeProfile } from './tool-scope';
export { BUILTIN_FALLBACK_RULES } from './builtin-rules';
export { AuditLogger } from './audit-logger';
export { ToolsConfigLoader } from './tools-config-loader';
export { parseSimpleYaml } from './simple-yaml';
export {
  TOOL_LICENSE_REGISTRY,
  TOOL_LOCKFILE_SCHEMA_VERSION,
  defaultToolBinDir,
  defaultToolLockfilePath,
  loadToolLockfile,
  saveToolLockfile,
} from './toolchain/types';
export type {
  LicenseAuditor,
  LicenseMatrixReport,
  ToolChannel,
  ToolInstallRecord,
  ToolLicense,
  ToolLockfile,
  ToolRequirement,
} from './toolchain/types';
export {
  getToolDimensions,
  mapIssuesToDimensions,
  computeOverallScore,
  scoreToGrade,
} from './dimension-mapper';
export type {
  EventEmitter,
  GovernanceEvent,
  ToolExecutedEvent,
  ScanCompletedEvent,
  GuardCheckRequestedEvent,
  GuardCheckCompletedEvent,
  GuardStage,
  ScopeViolationEvent,
} from './events';
export { NOOP_EMITTER } from './events';

// 十域职责边界契约（07 号规范）：统一信封 + 归属/能力注册表 + 路径归一化
export {
  DOMAIN_IDS,
  COVERAGE_THRESHOLD,
  createDomainReport,
  toAbsolutePath,
  toRelativePath,
  toFileUri,
  OWNERSHIP_CLAIMS,
  resolveOwnerClaim,
  resolveOwnerId,
  validateOwnershipRegistry,
  SCAN_DOMAIN_BUDGETS,
  TOOL_CAPABILITIES,
  findToolCapability,
  validateCapabilityRegistry,
  resolveSupplierDomain,
} from './domain-contract';
export type {
  DomainId,
  DomainRunStatus,
  ScoreBasis,
  SkippedReason,
  DomainIssue,
  SkippedCheck,
  DomainCoverage,
  DomainScore,
  DomainReport,
  DomainReportInput,
  OwnershipMatch,
  OwnershipClaim,
  OwnershipConflict,
  OwnershipConflictKind,
  ToolTargetKind,
  ToolRunRequirement,
  RuleFamily,
  ToolCapability,
  CapabilityViolation,
  CapabilityViolationKind,
  ConclusionIssue,
  DomainConclusion,
  DomainConclusionSet,
} from './domain-contract';

export { detectMachineProfile, type MachineProfile } from './machine-profile';
export {
  baselinePath,
  loadBaseline,
  saveBaseline,
  clearBaseline,
  baselineEntryKey,
  baselineKeySet,
  isBaselineEntryActive,
  toBaselineEntry,
  issuesToBaselineEntries,
  filterIssuesByBaseline,
  normalizeBaselineFile,
  type Baseline,
  type BaselineEntry,
  type BaselineFilterResult,
  type SuppressedIssue,
  readJsonBaseline,
  writeJsonBaselineAtomic,
  parseVersionedEnvelope,
  createBaselineIo,
  type BaselineIo,
} from './baseline';
export {
  refactorBaselinePath,
  loadRefactorBaseline,
  saveRefactorBaseline,
  clearRefactorBaseline,
} from './refactor-baseline-io';
export type { RefactorBaselineCounts, RefactorBaselineRecord } from './refactor-baseline-io';
export { safeReadDirEntries, expandHome } from './fs-safe';
export { NOISE_DIRS } from './noise-dirs';
export { escapeRegExp } from './text-utils';
export { withHardTimeout } from './promise-timeout';
export {
  withToolProcessScope,
  trackToolProcess,
  currentToolProcessScope,
  type ToolProcessScope,
} from './tool-process-registry';
export { DEFAULT_SCAN_EXCLUDE_DIRS, appendScanExcludeArgs } from './scan-exclude-dirs';
export { resolveSourceScanTarget } from './scan-target';
export { sanitizeEnv } from './process-env';
export { augmentProcessPath } from './path-augment';
export { sanitizeLogField, MAX_LOG_FIELD_LENGTH } from './log-sanitize';
export {
  safeJoin,
  safeJoinReal,
  safeResolve,
  safeResolveReal,
  PathTraversalError,
} from './security/safe-path';
export {
  ESLINT_CONFIG_NAMES,
  findEslintConfigDir,
  hasEslintConfig,
  resolveEslintConfigPath,
  resolveEslintTargetDir,
} from './eslint-config';
export { scanGarbageDir, dirSizeOf } from './garbage-scan';
export type { GarbageScanOptions, DirSizeOptions } from './garbage-scan';
export {
  normalizePackageName,
  extractPyprojectDeps,
  extractRequirementsNames,
} from './manifest-parsers';
export type { ProjectLanguage, PackageManager, ProjectProfile } from './project-profile';
export {
  HEALTH_SCORE_DIMENSIONS,
  SCORE_DIMENSIONS,
  REFERENCE_DIMENSIONS,
  SCORED_DIMENSIONS,
  isScoreDimension,
  isReferenceDimension,
  isScoredDimension,
} from './score-dimensions';
export type { HealthScoreDimension, ScoreDimension, DimensionCoverage } from './score-dimensions';
