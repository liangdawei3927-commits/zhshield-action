// ─── _meta: 核心类型与注册 ──────────────────────────────────
export type {
  GovernanceDomain,
  ActionType,
  DataSource,
  RuleLifecycleStatus,
  ExecutionMode,
  SopRule,
  SopServes,
  SopVersion,
  SopDiff,
  SopDiffMetadata,
  SignedSopPackage,
  SyncResult,
  SopRuleFilter,
  ProjectFeature,
  SopRuleStats,
} from './_meta/sop-types';

export { SopRegistry } from './_meta/sop-registry';
export type { RuleChangeEvent } from './_meta/sop-registry';
export { SopLoader } from './_meta/sop-loader';
export type { SopLoaderOptions } from './_meta/sop-loader';

// ─── cache: 本地缓存与同步 ──────────────────────────────────
export { SopCacheManager, createSyncPolicy } from './cache/sop-cache-manager';
export type {
  SopCacheManagerOptions,
  SyncPolicyOptions,
} from './cache/sop-cache-manager';
export { ContentAddressableStore } from './cache/content-addressable-store';
export { SopCompressor, CompressionFormat } from './cache/sop-compressor';
export { SopLazyLoader } from './cache/sop-lazy-loader';
export { SopPredictiveLoader } from './cache/sop-predictive-loader';

// ─── security: 签名与加密 ───────────────────────────────────
export { SopSigner } from './security/sop-signer';
export type { VerifyResult, EncryptedData } from './security/sop-signer';

// ─── sync: 智汇大脑协同 ─────────────────────────────────
export {
  ToolRuleSync,
  ExperienceReporter,
  WisdomBrainSync,
  hashToolRuleFiles,
  buildDefaultToolRuleConfigs,
  resolveApiBase,
  resolveSopBase,
} from './sync';
export type {
  ToolId,
  ToolRuleSyncConfig,
  ToolRuleVersion,
  ToolRuleSyncResult,
  ToolRuleFile,
  ExperienceType,
  ExperienceRecord,
  ExperienceReportResult,
  VersionLock,
  ExperienceSyncPayload,
  WisdomBrainSyncResult,
} from './sync';
