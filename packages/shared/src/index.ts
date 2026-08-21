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
  FallbackStrategy,
  ToolVersionInfo,
  ToolErrorLog,
  AuditAction,
  AuditLogEntry,
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
export {
  TOOL_LICENSE_REGISTRY,
  TOOL_LOCKFILE_SCHEMA_VERSION,
  defaultToolLockfilePath,
  defaultToolBinDir,
  loadToolLockfile,
  saveToolLockfile,
} from './toolchain/types';
export type {
  ToolChannel,
  ToolLicense,
  ToolInstallRecord,
  ToolLockfile,
  ToolRequirement,
  LicenseMatrixReport,
  LicenseAuditor,
} from './toolchain/types';
export { sanitizeEnv } from './process-env';
export { toolMappers, eslintMapper, semgrepMapper, trivyMapper, grypeMapper, gitleaksMapper, depcheckMapper, depCruiserMapper, jscpdMapper } from './output-mappers';
export { DegradationManager } from './degradation-manager';
export { BUILTIN_FALLBACK_RULES } from './builtin-rules';
export { AuditLogger } from './audit-logger';
export { ToolsConfigLoader } from './tools-config-loader';
export { getToolDimensions, mapIssuesToDimensions, computeOverallScore, scoreToGrade } from './dimension-mapper';
export type { EventEmitter, GovernanceEvent, ToolExecutedEvent, ScanCompletedEvent, GuardCheckRequestedEvent, GuardCheckCompletedEvent, GuardStage, KernelEventMap, KernelRuleEngineReport, KernelRuleChangeEvent } from './events';
export { NOOP_EMITTER } from './events';
