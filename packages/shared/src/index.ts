// @zh/shared - 所有模块共用的类型定义
export const VERSION = '0.1.0';
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
  SyncResult,
} from './types';
export { ToolManager } from './tool-manager';
export { wrapAdapter, evaluateAccessScope } from './tool-adapter-decorator';
export type { HookedToolResult, ScopeViolation, ScopeViolationContext, WrapAdapterOptions } from './tool-adapter-decorator';
export { matchGlobPath } from './scope-matcher';
export { toolMappers, eslintMapper, semgrepMapper, trivyMapper, grypeMapper, gitleaksMapper, depcheckMapper, depCruiserMapper, jscpdMapper } from './output-mappers';
export { DegradationManager } from './degradation-manager';
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
export { getToolDimensions, mapIssuesToDimensions, computeOverallScore, scoreToGrade } from './dimension-mapper';
export type { EventEmitter, GovernanceEvent, ToolExecutedEvent, ScanCompletedEvent, GuardCheckRequestedEvent, GuardCheckCompletedEvent, GuardStage, ScopeViolationEvent } from './events';
export { NOOP_EMITTER } from './events';

export { sanitizeEnv } from './process-env';
export { augmentProcessPath } from './path-augment';
export { sanitizeLogField, MAX_LOG_FIELD_LENGTH } from './log-sanitize';
export { safeJoin, safeResolve, PathTraversalError } from './security/safe-path';
