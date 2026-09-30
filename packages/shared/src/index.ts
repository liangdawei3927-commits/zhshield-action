// @zh/shared - 所有模块共用的类型定义
export const VERSION = '0.1.0';
export { TOOL_IDS, GOVERNANCE_DOMAINS, INSPECT_SCOPE_DOMAINS } from './types';
// 跨域单一来源（T8 口径统一）：门禁 与 体检/安全中心 共用同一份规则定义
export {
  CLEAN_ARCH_LAYERS,
  ARCH_LAYER_EXCLUDED_DIRS,
  ARCH_LAYER_EXCLUDE_PATTERNS,
  allowedDependenciesOf,
  isLayerDependencyAllowed,
  type ArchLayer,
} from './arch-layers';
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
  HealthScore,
  AdapterResult,
  InspectionReport,
  SentinelEvent,
  EventType,
  EventSeverity,
  EventSource,
  CodeLocation,
  EventContext,
  Diagnosis,
  Vulnerability,
  MalwareItem,
  GarbageItem,
  GarbageItemType,
  ExperienceEntry,
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
  AccessScope,
  ToolCallHook,
  ToolVersionInfo,
  ToolErrorLog,
  AuditAction,
  AuditLogEntry,
  AuditEntry,
  WhitelistScope,
  WhitelistEntry,
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
  ActionType,
  DataSource,
  RuleLifecycleStatus,
  SopVersion,
  SopDiff,
  SopDiffMetadata,
  SyncResult,
} from './types';
export { ToolManager } from './tool-manager';
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

export { detectMachineProfile, type MachineProfile } from './machine-profile';
export {
  baselinePath,
  loadBaseline,
  saveBaseline,
  clearBaseline,
  baselineEntryKey,
  baselineKeySet,
  toBaselineEntry,
  issuesToBaselineEntries,
  filterIssuesByBaseline,
  normalizeBaselineFile,
  type Baseline,
  type BaselineEntry,
  type BaselineFilterResult,
} from './baseline';
export { safeReadDirEntries } from './fs-safe';
export { withHardTimeout } from './promise-timeout';
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
