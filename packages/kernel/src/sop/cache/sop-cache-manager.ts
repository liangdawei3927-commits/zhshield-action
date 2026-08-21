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
} from '../_meta/sop-types';

/**
 * ProjectProfile 的最小投影输入（结构化类型，避免反向依赖 @zh/fingerprint）。
 * 架构文档 §11.1：syncForProject 支持接收 ProjectProfile 自动投影。
 *
 * 与 @zh/fingerprint 的 ProjectProfile 结构兼容：
 * schemaVersion / targets[{ language, frameworks, productForm }] / architecture / environments
 */
interface ProfileProjectable {
  readonly targets: readonly Readonly<{
    readonly language: Readonly<{ readonly value: string }>;
    readonly frameworks: readonly Readonly<{ readonly value: string }>[];
    readonly productForm?: Readonly<{ readonly value: string }>;
  }>[];
  readonly architecture: Readonly<{ readonly value: string }>;
  readonly environments: readonly Readonly<{ readonly value: string }>[];
}

function isProjectFeature(input: ProjectFeature | ProfileProjectable): input is ProjectFeature {
  return 'features' in input && Array.isArray((input as ProjectFeature).features);
}

function projectToFeature(profile: ProfileProjectable): ProjectFeature {
  const primary = profile.targets[0];
  if (!primary) {
    return { features: [] };
  }

  const language = primary.language.value !== 'unknown' ? primary.language.value : undefined;
  const framework = primary.frameworks[0]?.value;
  const features: string[] = [];

  if (primary.productForm) {
    features.push(primary.productForm.value);
  }
  if (profile.architecture.value !== 'unknown') {
    features.push(profile.architecture.value);
  }
  for (const env of profile.environments) {
    features.push(env.value);
  }

  return { language, framework, features };
}
import type { SopRegistry } from '../_meta/sop-registry';
import type { ContentAddressableStore } from './content-addressable-store';
import { SopLazyLoader } from './sop-lazy-loader';
import type { EventBus } from '../../bus';
import { resolveSopBase } from '../sync/api-base';
import { createSyncPolicy } from './sop-sync-policy';
import type { SyncPolicyOptions } from './sop-sync-policy';
import { SopSqliteStore } from './sop-sqlite-store';
import type { SopSqliteStoreEncryptionOptions } from './sop-sqlite-store';
import { SopVersionStore } from './sop-version-store';
import { SopSyncClient } from './sop-sync-client';
import { SopSyncCoordinator } from './sop-sync-coordinator';
import { SopSyncScheduler } from './sop-sync-scheduler';

export { createSyncPolicy } from './sop-sync-policy';
export type { SyncPolicyOptions } from './sop-sync-policy';

export interface SopCacheManagerOptions {
  cacheDir?: string;
  remoteBaseUrl?: string;
  lazyLoading?: boolean;
  syncPolicy?: SyncPolicyOptions;
  clientVersion?: string;
  eventBus?: EventBus;
  publicKey?: string | (() => Promise<string | null>);
  encryption?: SopSqliteStoreEncryptionOptions;
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
 * - 校验规则包完整性和签名
 * - 降级策略（Level 0-4）
 */
export class SopCacheManager {
  private cacheDir: string;
  private registry: SopRegistry;
  private cas?: ContentAddressableStore;
  private lazyLoader?: SopLazyLoader;
  private syncPolicy: Required<SyncPolicyOptions>;
  private sqliteStore: SopSqliteStore;
  private versionStore: SopVersionStore;
  private scheduler: SopSyncScheduler;
  private coordinator: SopSyncCoordinator;

  constructor(registry: SopRegistry, options: SopCacheManagerOptions = {}) {
    this.registry = registry;
    this.cacheDir = options.cacheDir ?? path.join(os.homedir(), '.zhshield', 'sop-cache');
    const remoteBaseUrl = options.remoteBaseUrl ?? resolveSopBase();
    const clientVersion = options.clientVersion ?? '0.0.0';
    this.syncPolicy = createSyncPolicy(options.syncPolicy);

    if (options.lazyLoading !== false) {
      this.lazyLoader = new SopLazyLoader(this);
    }

    this.sqliteStore = new SopSqliteStore(path.join(this.cacheDir, 'rules.db'), options.encryption);
    this.versionStore = new SopVersionStore(this.cacheDir);
    const syncClient = new SopSyncClient(remoteBaseUrl, undefined, options.publicKey);
    this.scheduler = new SopSyncScheduler(this.syncPolicy);
    this.coordinator = new SopSyncCoordinator({
      registry,
      clientVersion,
      eventBus: options.eventBus,
      sqliteStore: this.sqliteStore,
      versionStore: this.versionStore,
      syncClient,
      scheduler: this.scheduler,
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
    return this.coordinator.syncFromCloud();
  }

  /**
   * 应用增量更新（文档 13.3 节）
   */
  async applyDiff(diff: SopDiff): Promise<void> {
    return this.coordinator.applyDiff(diff);
  }

  /**
   * 紧急更新（7.2 节）— 高危规则实时推送
   */
  async emergencyUpdate(rules: SopRule[]): Promise<void> {
    return this.coordinator.emergencyUpdate(rules);
  }

  // ─── 本地缓存管理 ──────────────────────────────────────────

  /**
   * 从本地缓存加载指定模块的规则（懒加载用）
   */
  async loadRules(module: string): Promise<SopRule[]> {
    // 先尝试从注册中心获取活跃规则
    const cached = this.registry.getByDomain(module as GovernanceDomain);
    if (cached.length > 0) return cached;

    // 尝试从 SQLite 按 domain 查询
    return this.sqliteStore.loadByDomain(module);
  }

  /**
   * 清理缓存
   */
  async clearCache(): Promise<void> {
    return this.coordinator.clearCache();
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

  async syncForProject(feature: ProjectFeature): Promise<void>;
  async syncForProject(profile: ProfileProjectable): Promise<void>;
  async syncForProject(input: ProjectFeature | ProfileProjectable): Promise<void> {
    if (!this.lazyLoader) return;
    const feature = isProjectFeature(input) ? input : projectToFeature(input);
    await this.lazyLoader.syncForProject(feature);
  }

  getLazyLoader(): SopLazyLoader | undefined {
    return this.lazyLoader;
  }

  setContentAddressableStore(store: ContentAddressableStore): void {
    this.cas = store;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getRegistry(): SopRegistry {
    return this.registry;
  }
}
