import * as crypto from 'node:crypto';
import type { SopRule, SopVersion, SopDiff, SyncResult } from '../_meta/sop-types';
import type { SopRegistry } from '../_meta/sop-registry';
import type { EventBus } from '../../bus';
import type { SopSqliteStore } from './sop-sqlite-store';
import type { SopVersionStore } from './sop-version-store';
import type { SopSyncClient } from './sop-sync-client';
import type { SopSyncScheduler } from './sop-sync-scheduler';

const MAJOR_VERSION = /^(\d+)\./;

export interface SopSyncCoordinatorOptions {
  registry: SopRegistry;
  clientVersion: string;
  eventBus?: EventBus;
  sqliteStore: SopSqliteStore;
  versionStore: SopVersionStore;
  syncClient: SopSyncClient;
  scheduler: SopSyncScheduler;
}

/**
 * SopSyncCoordinator — 同步编排器
 *
 * 负责版本对比、增量/全量同步、应用 diff、紧急更新与缓存清理。
 * 持有同步版本状态：localVersion；定时调度与健康度评估委托给 SopSyncScheduler。
 */
export class SopSyncCoordinator {
  private registry: SopRegistry;
  private clientVersion: string;
  private eventBus?: EventBus;
  private sqliteStore: SopSqliteStore;
  private versionStore: SopVersionStore;
  private syncClient: SopSyncClient;
  private scheduler: SopSyncScheduler;

  private localVersion: SopVersion | null = null;

  constructor(options: SopSyncCoordinatorOptions) {
    this.registry = options.registry;
    this.clientVersion = options.clientVersion;
    this.eventBus = options.eventBus;
    this.sqliteStore = options.sqliteStore;
    this.versionStore = options.versionStore;
    this.syncClient = options.syncClient;
    this.scheduler = options.scheduler;
  }

  // ─── 初始化 ────────────────────────────────────────────────

  /** 读取本地版本号并加载本地缓存的规则到注册中心 */
  async initialize(): Promise<void> {
    this.localVersion = await this.versionStore.load();

    const rules = this.sqliteStore.loadAll();
    if (rules.length > 0) {
      this.registry.loadAll(rules);
    }
  }

  // ─── 版本管理 ──────────────────────────────────────────────

  getLocalVersion(): SopVersion | null {
    return this.localVersion;
  }

  private async saveVersion(version: SopVersion): Promise<void> {
    await this.versionStore.save(version);
    this.localVersion = version;
  }

  // ─── 云端同步（7.4 完整同步流程） ───────────────────────────

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopVersion | null> {
    return this.syncClient.checkRemoteVersion();
  }

  /**
   * 完整同步流程（文档 7.4 节）：
   * 1. 检查版本
   * 2. 对比本地版本
   * 3. 下载增量更新
   * 4. 写入本地缓存
   * 5. 校验完整性
   */
  async syncFromCloud(): Promise<SyncResult> {
    if (!this.scheduler.isOnline) {
      return { updated: false, reason: 'network_error' };
    }

    const remoteVersion = await this.checkRemoteVersion();
    if (!remoteVersion) {
      return { updated: false, reason: 'network_error' };
    }

    return this.resolveRemoteSync(remoteVersion);
  }

  private async resolveRemoteSync(remoteVersion: SopVersion): Promise<SyncResult> {
    const state = this.compareVersions(remoteVersion);
    if (state === 'latest') {
      this.scheduler.recordSync();
      return { updated: false, reason: 'already_latest' };
    }
    if (state === 'reset') {
      console.warn('[SopCacheManager] Local version > remote version, resetting');
      await this.clearCache();
    }

    return this.applyRemoteDiff(remoteVersion);
  }

  private async applyRemoteDiff(remoteVersion: SopVersion): Promise<SyncResult> {
    const fromVersion = this.localVersion?.version ?? '0.0.0';
    const diff = await this.syncClient.fetchDiff(fromVersion, remoteVersion.version);

    if (!diff) {
      return this.fullSync(remoteVersion);
    }

    return this.applyIncrementalOrFallback(diff, fromVersion, remoteVersion);
  }

  private async applyIncrementalOrFallback(
    diff: SopDiff,
    fromVersion: string,
    remoteVersion: SopVersion,
  ): Promise<SyncResult> {
    if (!this.checkCompatibility(diff.compatibility)) {
      return { updated: false, reason: 'compatibility_error' };
    }

    try {
      return await this.applyIncremental(diff, fromVersion, remoteVersion);
    } catch (err) {
      console.error('[SopCacheManager] Failed to apply diff:', err);
      return this.fullSync(remoteVersion);
    }
  }

  private compareVersions(remoteVersion: SopVersion): 'latest' | 'reset' | 'proceed' {
    if (this.localVersion && this.localVersion.version === remoteVersion.version) {
      return 'latest';
    }
    if (this.localVersion && this.localVersion.version > remoteVersion.version) {
      return 'reset';
    }
    return 'proceed';
  }

  private async applyIncremental(
    diff: SopDiff,
    fromVersion: string,
    remoteVersion: SopVersion,
  ): Promise<SyncResult> {
    await this.applyDiff(diff);
    await this.saveVersion(remoteVersion);
    this.scheduler.recordSync();
    await this.versionStore.logSync({
      from: fromVersion,
      to: remoteVersion.version,
      type: 'incremental',
    });

    this.eventBus?.emit('sop:cache-synced', {
      type: 'incremental',
      fromVersion,
      toVersion: remoteVersion.version,
      ruleCount: diff.added.length + diff.modified.length + diff.removed.length,
      timestamp: new Date(),
    });

    return {
      updated: true,
      fromVersion,
      toVersion: remoteVersion.version,
      ruleCount: diff.added.length + diff.modified.length,
    };
  }

  /**
   * 全量同步（增量失败时的降级）
   */
  private async fullSync(remoteVersion: SopVersion): Promise<SyncResult> {
    try {
      const rules = await this.syncClient.fetchFull(remoteVersion.version);
      if (!rules) return { updated: false, reason: 'network_error' };
      this.registry.loadAll(rules);
      this.sqliteStore.persist(rules);
      await this.saveVersion(remoteVersion);
      this.scheduler.recordSync();
      await this.versionStore.logSync({ from: '0.0.0', to: remoteVersion.version, type: 'full' });
      this.eventBus?.emit('sop:cache-synced', {
        type: 'full',
        toVersion: remoteVersion.version,
        ruleCount: rules.length,
        timestamp: new Date(),
      });
      return { updated: true, toVersion: remoteVersion.version, ruleCount: rules.length };
    } catch {
      return { updated: false, reason: 'network_error' };
    }
  }

  // ─── 应用增量更新（13.3 节） ───────────────────────────────

  /**
   * 应用增量更新（文档 13.3 节）
   * 验证版本连续性 → 事务执行 → 记录同步日志
   */
  async applyDiff(diff: SopDiff): Promise<void> {
    this.verifyVersionContinuity(diff);
    this.applyChanges(diff);
    this.sqliteStore.persist(this.registry.getAll());

    await this.versionStore.logSync({
      from: diff.fromVersion,
      to: diff.version,
      added: diff.added.length,
      removed: diff.removed.length,
      modified: diff.modified.length,
      type: 'incremental',
    });
  }

  private verifyVersionContinuity(diff: SopDiff): void {
    const localVersion = this.localVersion?.version ?? '0.0.0';
    if (localVersion !== diff.fromVersion) {
      throw new Error(`Version mismatch: local=${localVersion}, expected=${diff.fromVersion}`);
    }

    const hashPayload = JSON.stringify({
      added: diff.added,
      modified: diff.modified,
      removed: diff.removed,
    });
    const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');
    if (diff.metadata.hash && hash !== diff.metadata.hash) {
      throw new Error(`Hash mismatch: expected=${diff.metadata.hash}, got=${hash}`);
    }
  }

  private applyChanges(diff: SopDiff): void {
    for (const ruleId of diff.removed) {
      this.registry.remove(ruleId);
    }
    for (const rule of diff.modified) {
      this.registry.update(rule.id, rule);
    }
    this.upsertRules(diff.added);
  }

  private upsertRules(rules: SopRule[]): void {
    for (const rule of rules) {
      try {
        this.registry.register(rule);
      } catch {
        this.registry.update(rule.id, rule);
      }
    }
  }

  // ─── 紧急更新（7.2 节） ────────────────────────────────────

  /**
   * 紧急更新（高危规则实时推送）
   * 安全漏洞发现后立即下发，不等待每日定时同步
   */
  async emergencyUpdate(rules: SopRule[]): Promise<void> {
    this.upsertRules(rules);
    this.sqliteStore.persist(rules);
    this.scheduler.recordSync();

    await this.versionStore.logSync({
      to: 'emergency',
      added: rules.length,
      type: 'emergency',
    });

    this.eventBus?.emit('sop:emergency-updated', {
      count: rules.length,
      ruleIds: rules.map((r) => r.id),
      timestamp: new Date(),
    });
  }

  // ─── 缓存清理 ──────────────────────────────────────────────

  /**
   * 清理缓存（注册中心 + SQLite + 内存版本号）
   */
  async clearCache(): Promise<void> {
    this.registry.clear();
    this.sqliteStore.clear();
    this.localVersion = null;
  }

  // ─── 版本兼容性检查 ────────────────────────────────────────

  /**
   * 检查规则兼容性（文档 8.4 节）
   * 防止旧版客户端加载不兼容的新规则
   */
  private checkCompatibility(requiredVersion: string): boolean {
    const localMajor = SopSyncCoordinator.extractMajor(this.clientVersion);
    const requiredMajor = SopSyncCoordinator.extractMajor(requiredVersion);
    if (localMajor === null || requiredMajor === null) return true;
    return localMajor >= requiredMajor;
  }

  private static extractMajor(version: string): number | null {
    const match = MAJOR_VERSION.exec(version);
    return match ? parseInt(match[1], 10) : null;
  }
}
