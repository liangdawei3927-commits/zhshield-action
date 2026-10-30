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
// 云端规则缓存定位（CLI / 本地检查脚本共用）：判错即「门禁整段失声」，
// 因为两条阻断型门禁只在云端下发、内置模板里没有。
export {
  resolveSopCacheDir,
  resolveDesktopCacheDir,
  resolveCliCacheDir,
  readCacheFreshness,
  currentSopCacheEnv,
} from './cache/sop-cache-locator';
export type {
  SopCacheResolution,
  SopCacheEnv,
  CacheFreshness,
} from './cache/sop-cache-locator';
export type {
  SopCacheManagerOptions,
  SyncPolicyOptions,
  SyncFailureKind,
  SyncHealthDetail,
  SopSyncState,
} from './cache/sop-cache-manager';
export { ContentAddressableStore } from './cache/content-addressable-store';
export { SopCompressor, CompressionFormat } from './cache/sop-compressor';
export { SopLazyLoader } from './cache/sop-lazy-loader';
export { SopPredictiveLoader } from './cache/sop-predictive-loader';

// ─── cache: 云端取数原语（给非 Electron 入口用，如 CLI 的 sop sync）──
// 只导出「取数 + 验签」两个无状态原语，**不导出 SopCacheManager**：后者依赖
// better-sqlite3（native）与 Electron 生命周期，CLI 打包进去只会得到一个装不起来的模块。
export { SopSyncClient } from './cache/sop-sync-client';
export type {
  ApiTokenProvider,
  SopFetchFailure,
  SopFetchFailureKind,
  SopFetchResult,
} from './cache/sop-sync-client';
export { VerifiedSopSyncClient } from './cache/sop-verified-sync-client';
export type { VerifiedSopSyncClientOptions } from './cache/sop-verified-sync-client';
export { SopSignatureVerifier } from './cache/sop-signature-verifier';

// ─── security: 签名与加密 ───────────────────────────────────
export { SopSigner } from './security/sop-signer';
export type { VerifyResult, EncryptedData } from './security/sop-signer';

// ─── sync: 智汇大脑协同 ─────────────────────────────────
export {
  ToolRuleSync,
  EXPIRY_THRESHOLD_DAYS,
  ExperienceReporter,
  WisdomBrainSync,
  hashToolRuleFiles,
  buildDefaultToolRuleConfigs,
  resolveApiBase,
  resolveSopBase,
  readApiToken,
  resolveTools,
  resolveRules,
  registerProjectFeatures,
  unregisterProjectFeatures,
  resolveHealth,
  readOrCreateUserId,
  getOrCreateDefaultOrg,
  getReclaimingToolRuleIds,
  getReclaimingToolRuleSinces,
  getReclaimingSopModuleIds,
  getReclaimingSopModuleSinces,
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
  ScopeProfileLike,
  ResolveRulesResponse,
  DefaultOrgResult,
} from './sync';

// ─── 深度优化协作者：冲突解决 / 压缩 / 清理 / 缓存指标与维护 ──
export { SyncConflictResolver, ConflictResolution } from './sync-conflict';
export type { SyncConflict } from './sync-conflict';
export { SmartCompressor } from './smart-compressor';
export type { CompressionStrategy, CompressedData } from './smart-compressor';
export { DataCleanup } from './data-cleanup';
export type { CleanupConfig, CleanupResult } from './data-cleanup';
export { SopCacheMetrics } from './cache/sop-cache-metrics';
export type { SopCacheMetricsSnapshot } from './cache/sop-cache-metrics';
export { SopCacheMaintenance, DEFAULT_SOP_CLEANUP_CONFIG } from './cache/sop-cache-maintenance';
export type {
  MaintenanceTrigger,
  MaintenanceOutcome,
  SopCacheMaintenanceOptions,
} from './cache/sop-cache-maintenance';
export { 
  computeRuleContentSha,
  buildCurrentVersions,
  verifyRuleManifest,
  needsHeal,
} from './cache/sop-resolve-verifier';
export type { RuleManifestEntry, ResolveDriftReport } from './cache/sop-resolve-verifier';

// ─── quality: 规则质量门禁（2026-09-22 建立）──────────────────
// 规则升 active / 改动后必须过 golden 断言回放，precision/recall 达标才放行。
// 动机：Gate 原本只认「单测全绿」，照不到「规则报得对不对」（已有 358 条误报实证）。
export {
  evaluateRuleAccuracy,
  loadRuleGoldenDir,
  toRuleFindings,
  formatRuleAccuracyReport,
  RULE_PRECISION_THRESHOLD,
  RULE_RECALL_THRESHOLD,
  DEFAULT_LINE_TOLERANCE,
} from './quality/rule-accuracy';
export type {
  RuleGoldenAssertion,
  RuleGoldenFile,
  RuleFinding,
  RuleEvaluation,
  RuleAccuracyReport,
  EvaluateRuleAccuracyOptions,
} from './quality/rule-accuracy';
