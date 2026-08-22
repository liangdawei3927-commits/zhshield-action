import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  SopRule,
  SopVersion,
  SopDiff,
  SyncResult,
  GovernanceDomain,
  ProjectFeature,
  ProjectProfile,
} from '../_meta/sop-types';
import type { SopRegistry } from '../_meta/sop-registry';
import { SopLazyLoader } from './sop-lazy-loader';
import { SopSignatureVerifier } from './sop-signature-verifier';
import type { EventBus } from '../../bus';
import { resolveSopBase } from '../sync/api-base';
import { createSyncPolicy } from './sop-sync-policy';
import type { SyncPolicyOptions } from './sop-sync-policy';
import { SopSqliteStore } from './sop-sqlite-store';
import { SopVersionStore } from './sop-version-store';
import { SopSyncClient } from './sop-sync-client';
import { VerifiedSopSyncClient } from './sop-verified-sync-client';
import { SopSyncCoordinator } from './sop-sync-coordinator';
import { SopSyncScheduler } from './sop-sync-scheduler';
import { SyncConflictResolver, ConflictResolution } from '../sync-conflict';
import { SmartCompressor } from '../smart-compressor';
import { DataCleanup } from '../data-cleanup';
import type { CleanupConfig } from '../data-cleanup';
import type { MetricsCollector } from '../../metrics/metrics-collector';
import { SopCacheMetrics } from './sop-cache-metrics';
import type { SopCacheMetricsSnapshot } from './sop-cache-metrics';
import { SopCacheMaintenance } from './sop-cache-maintenance';

export { createSyncPolicy } from './sop-sync-policy';
export type { SyncPolicyOptions } from './sop-sync-policy';

export interface SopCacheManagerOptions {
  /** 缓存根目录，默认 ~/.zhshield/sop-cache */
  cacheDir?: string;
  /** 远程 API 基础 URL */
  remoteBaseUrl?: string;
  /** 是否启用懒加载 */
  lazyLoading?: boolean;
  /** 同步策略（同步间隔 + 过期阈值），省略时使用默认值 */
  syncPolicy?: SyncPolicyOptions;
  /** 本地桌面端版本号（用于兼容性检查，例 '1.0.0'） */
  clientVersion?: string;
  /** 事件总线（用于通知下游紧急更新等事件） */
  eventBus?: EventBus;
  /** HMAC-SHA256 签名密钥（用于验证云端规则包完整性） */
  secretKey?: string;
  /** 验签公钥：字符串或异步解析函数；未配置时验签放行（向后兼容），配置后解析失败则 fail-closed */
  publicKey?: string | (() => Promise<string | null>);
  /** 云端/本地规则冲突自动解决策略，默认 REMOTE_WINS（与既有「云端覆盖本地」行为一致） */
  conflictStrategy?: ConflictResolution;
  /** 外部指标收集器（注入后可与外部仪表盘共享同一份数据） */
  metricsCollector?: MetricsCollector;
  /** 数据清理配置（条目上限/日志时间淘汰/保留下限），省略时使用默认值 */
  cleanup?: Partial<CleanupConfig>;
}

/**
 * SopCacheManager — 本地规则缓存管理器（门面）
 *
 * 核心原则：桌面端永远不直接读云端，只读本地缓存。网络断开也能正常工作。
 *
 * 职责（已拆分到独立组件，本类只做编排）：
 * - SopSqliteStore：本地 SQLite 规则缓存
 * - SopVersionStore：本地版本号与同步日志
 * - SopSyncClient：云端通信（版本检查 / 增量 diff / 全量包）
 * - SopSyncCoordinator：同步编排（版本对比、增量/全量同步、紧急更新）
 * - SopSyncScheduler：定时调度与降级健康度评估
 *
 * 对外保持以下职责：
 * - 管理本地缓存与云端同步
 * - 支持紧急更新推送
 * - 签名校验由 SopSignatureVerifier 承担（经 VerifiedSopSyncClient 接入同步链路）
 * - 降级策略（Level 0-4）
 */
export class SopCacheManager {
  private cacheDir: string;
  private registry: SopRegistry;
  private lazyLoader?: SopLazyLoader;
  private syncPolicy: Required<SyncPolicyOptions>;
  private sqliteStore: SopSqliteStore;
  private versionStore: SopVersionStore;
  private scheduler: SopSyncScheduler;
  private coordinator: SopSyncCoordinator;
  private eventBus?: EventBus;
  private secretKey?: string;
  private metrics: SopCacheMetrics;
  private maintenance: SopCacheMaintenance;

  constructor(registry: SopRegistry, options: SopCacheManagerOptions = {}) {
    this.registry = registry;
    this.cacheDir = options.cacheDir ?? path.join(os.homedir(), '.zhshield', 'sop-cache');
    const remoteBaseUrl = options.remoteBaseUrl ?? resolveSopBase();
    const clientVersion = options.clientVersion ?? '0.0.0';
    this.syncPolicy = createSyncPolicy(options.syncPolicy);
    this.eventBus = options.eventBus;
    this.secretKey = options.secretKey;

    if (options.lazyLoading !== false) {
      this.lazyLoader = new SopLazyLoader(this);
    }

    this.sqliteStore = new SopSqliteStore(path.join(this.cacheDir, 'rules.db'), {
      compressor: new SmartCompressor(),
    });
    this.versionStore = new SopVersionStore(this.cacheDir);
    this.metrics = new SopCacheMetrics(options.metricsCollector);
    this.maintenance = new SopCacheMaintenance({
      registry,
      sqliteStore: this.sqliteStore,
      versionStore: this.versionStore,
      cleanup: new DataCleanup(options.cleanup),
      cleanupConfig: options.cleanup,
      metrics: this.metrics,
      eventBus: this.eventBus,
    });
    const signatureVerifier = new SopSignatureVerifier(options.publicKey);
    const syncClient = options.publicKey !== undefined
      ? new VerifiedSopSyncClient(remoteBaseUrl, (pkg) => signatureVerifier.verifySignature(pkg))
      : new SopSyncClient(remoteBaseUrl);
    this.scheduler = new SopSyncScheduler(this.syncPolicy);
    this.coordinator = new SopSyncCoordinator({
      registry,
      clientVersion,
      eventBus: this.eventBus,
      sqliteStore: this.sqliteStore,
      versionStore: this.versionStore,
      syncClient,
      scheduler: this.scheduler,
      conflictResolver: new SyncConflictResolver(),
      conflictStrategy: options.conflictStrategy ?? ConflictResolution.REMOTE_WINS,
      metrics: this.metrics,
    });
  }

  // ─── 初始化 ────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await fs.promises.mkdir(path.join(this.cacheDir, 'malware-db'), { recursive: true });

    // 初始化 SQLite 数据库
    this.sqliteStore.initialize();

    // 读取本地版本号并加载本地缓存的规则
    await this.coordinator.initialize();

    // 启动时自动维护（大小裁剪 + 日志清理），失败不阻塞初始化
    await this.maintenance.run('init');
  }

  // ─── 版本管理 ──────────────────────────────────────────────

  async getLocalVersion(): Promise<SopVersion | null> {
    return this.coordinator.getLocalVersion();
  }

  // ─── 云端同步（7.4 完整同步流程） ───────────────────────────

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopVersion | null> {
    return this.coordinator.checkRemoteVersion();
  }

  /**
   * 完整同步流程（文档 7.4 节）
   */
  async syncFromCloud(): Promise<SyncResult> {
    const startedAt = Date.now();
    this.emit('sop:sync-started');
    try {
      const result = await this.coordinator.syncFromCloud();
      this.metrics.recordSyncSuccess(Date.now() - startedAt);
      this.emit('sop:sync-completed', { result, timestamp: new Date() });
      return result;
    } catch (err) {
      this.metrics.recordSyncFailure(Date.now() - startedAt);
      this.emit('sop:sync-failed', {
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
      });
      throw err;
    }
  }

  /**
   * 应用增量更新（文档 13.3 节）
   */
  async applyDiff(diff: SopDiff): Promise<void> {
    this.emit('sop:diff-started', {
      fromVersion: diff.fromVersion,
      toVersion: diff.version,
      timestamp: new Date(),
    });
    await this.coordinator.applyDiff(diff);
    this.emit('sop:diff-completed', {
      fromVersion: diff.fromVersion,
      toVersion: diff.version,
      ruleCount: diff.added.length + diff.modified.length + diff.removed.length,
      timestamp: new Date(),
    });
    this.emit('sop:cache-synced', {
      type: 'diff',
      fromVersion: diff.fromVersion,
      toVersion: diff.version,
      ruleCount: diff.added.length + diff.modified.length + diff.removed.length,
      timestamp: new Date(),
    });
    this.metrics.recordRulesApplied(
      diff.added.length + diff.modified.length + diff.removed.length,
      'diff',
    );
    await this.maintenance.run('diff');
  }

  /**
   * 紧急更新（7.2 节）— 高危规则实时推送
   */
  async emergencyUpdate(rules: SopRule[]): Promise<void> {
    this.emit('sop:emergency-started', { count: rules.length, timestamp: new Date() });
    await this.coordinator.emergencyUpdate(rules);
    this.emit('sop:emergency-completed', {
      count: rules.length,
      ruleIds: rules.map((r) => r.id),
      timestamp: new Date(),
    });
    this.emit('sop:cache-synced', {
      type: 'emergency',
      ruleCount: rules.length,
      timestamp: new Date(),
    });
    this.metrics.recordRulesApplied(rules.length, 'emergency');
    await this.maintenance.run('emergency');
  }

  // ─── 本地缓存管理 ──────────────────────────────────────────

  /**
   * 从本地缓存加载指定模块的规则（懒加载用）
   */
  async loadRules(module: string): Promise<SopRule[]> {
    // 先尝试从注册中心获取活跃规则
    const cached = this.registry.getByDomain(module as GovernanceDomain);
    if (cached.length > 0) {
      this.metrics.recordCacheLookup(module, true);
      return cached;
    }

    // 尝试从 SQLite 按 domain 查询
    const fromStore = await this.sqliteStore.loadByDomain(module);
    this.metrics.recordCacheLookup(module, fromStore.length > 0);
    return fromStore;
  }

  /**
   * 清理缓存
   */
  async clearCache(): Promise<void> {
    await this.coordinator.clearCache();
    this.emit('sop:cache-cleared', { cacheDir: this.cacheDir, timestamp: new Date() });
    this.emit('sop:cache-synced', { type: 'cleared', timestamp: new Date() });
    this.metrics.recordCleanup(0, 0);
  }

  // ─── 同步调度 ──────────────────────────────────────────────

  /**
   * 启动后台定时同步（7.5 节 触发方式 2）
   */
  startPeriodicSync(): void {
    this.scheduler.startPeriodicSync(() => this.coordinator.syncFromCloud());
  }

  /**
   * 停止定时同步
   */
  stopPeriodicSync(): void {
    this.scheduler.stopPeriodicSync();
  }

  /**
   * 启动时静默检查（7.5 节 触发方式 1）
   */
  async checkOnStartup(): Promise<SyncResult> {
    return this.coordinator.syncFromCloud();
  }

  /**
   * 设置在线状态
   */
  setOnline(online: boolean): void {
    this.scheduler.setOnline(online);
  }

  // ─── 降级策略（10.5 节） ───────────────────────────────────

  /**
   * 获取当前同步状态级别
   * Level 0: 正常  Level 1-3: 降级  Level 4: 严重过期
   */
  getSyncHealthLevel(): 0 | 1 | 2 | 3 | 4 {
    return this.scheduler.getSyncHealthLevel();
  }

  /**
   * 判断规则是否可能过期（需要显示警告）
   */
  isStale(): boolean {
    return this.scheduler.isStale();
  }

  // ─── 按项目特征同步（懒加载 9.5 节） ───────────────────────

  async syncForProject(feature: ProjectFeature | ProjectProfile): Promise<void> {
    if (this.lazyLoader) {
      const normalized = isProjectProfile(feature) ? projectProfileToFeature(feature) : feature;
      await this.lazyLoader.syncForProject(normalized);
    }
  }

  getLazyLoader(): SopLazyLoader | undefined {
    return this.lazyLoader;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getRegistry(): SopRegistry {
    return this.registry;
  }

  /**
   * 获取缓存业务指标快照（MetricsCollector 接入点）
   */
  getMetricsSnapshot(): SopCacheMetricsSnapshot {
    return this.metrics.snapshot();
  }

  // ─── 事件发射 ──────────────────────────────────────────────

  /**
   * 发射事件（fire-and-forget：监听器异常不影响主流程）
   */
  private emit(event: string, data: Record<string, unknown> = {}): void {
    if (this.eventBus) {
      this.eventBus.emit(event, data).catch(() => {});
    }
  }
}

function isProjectProfile(input: ProjectFeature | ProjectProfile): input is ProjectProfile {
  return Array.isArray((input as ProjectProfile).targets);
}

/** 结构化画像 → ProjectFeature 投影：language/framework 取首个 target，features 由 productForm/architecture/environments 组成 */
function projectProfileToFeature(profile: ProjectProfile): ProjectFeature {
  const target = profile.targets?.[0];
  const features: string[] = [];
  const addFeature = (value?: string) => {
    if (value && value !== 'unknown' && !features.includes(value)) features.push(value);
  };
  addFeature(target?.productForm?.value);
  addFeature(profile.architecture?.value);
  for (const env of profile.environments ?? []) addFeature(env.value);
  return {
    language: target?.language?.value,
    framework: target?.frameworks?.[0]?.value,
    features,
  };
}
