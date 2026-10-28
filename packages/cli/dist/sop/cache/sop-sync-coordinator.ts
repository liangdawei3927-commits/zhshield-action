import * as crypto from 'node:crypto';
import type {
  SopRule,
  SopVersion,
  SopDiff,
  SyncResult,
  SyncFailureReason,
} from '../_meta/sop-types';
import type { SopRegistry } from '../_meta/sop-registry';
import type { EventBus } from '../../bus';
import type { SyncConflictResolver, ConflictResolution } from '../sync-conflict';
import type { SopSqliteStore } from './sop-sqlite-store';
import type { SopVersionStore } from './sop-version-store';
import type { SopSyncClient, SopFetchFailure, SopFetchResult } from './sop-sync-client';
import type { SopSyncScheduler } from './sop-sync-scheduler';
import type { SopCacheMetrics } from './sop-cache-metrics';
import { SopConflictPolicy } from './sop-conflict-policy';
import { SopRuleAdmission } from './sop-rule-admission';
import { SopDiffApplier } from './sop-diff-applier';

const MAJOR_VERSION = /^(\d+)\./;

/** 把取数失败映射为同步原因：鉴权失败单独成类 —— 重试无用，须改令牌/权限配置 */
function toSyncReason(failure: SopFetchFailure): SyncFailureReason {
  if (failure.kind === 'http_error' && (failure.status === 401 || failure.status === 403)) {
    return 'auth_error';
  }
  return failure.kind;
}

/** 取数失败 → 同步结果；`cause` 用于保留上游失败原因（增量失败后降级全量时） */
function toFailureResult(failure: SopFetchFailure, cause?: string): SyncResult {
  return {
    updated: false,
    reason: toSyncReason(failure),
    detail: cause ? `${failure.detail}；上游原因: ${cause}` : failure.detail,
  };
}

/** 异常消息提取（catch 到的值不一定是 Error） */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 离线时的取数结果。必须与 `already_latest` 区分 ——
 * 否则面板会把「没联网」显示成「规则已是最新」。
 */
function offlineResult(): SopFetchResult<SopVersion> {
  return {
    ok: false,
    failure: { kind: 'network_error', url: '(scheduler)', detail: '调度器判定当前离线，未发起请求' },
  };
}

/** 客户端版本低于云端要求 */
function compatibilityFailure(clientVersion: string, required: string): SyncResult {
  return {
    updated: false,
    reason: 'compatibility_error',
    detail: `客户端 ${clientVersion} 低于云端要求 ${required}`,
  };
}

/** 规则取到了但落地失败（版本不连续 / 写库异常）——不是网络问题 */
function applyFailure(detail: string, cause?: string): SyncResult {
  return {
    updated: false,
    reason: 'apply_error',
    detail: cause ? `${detail}；上游原因: ${cause}` : detail,
  };
}

/** 同步协调器依赖：registry / clientVersion / sqliteStore / versionStore / syncClient / scheduler 必需，其余可选 */
export interface SopSyncCoordinatorOptions {
  registry: SopRegistry;
  clientVersion: string;
  eventBus?: EventBus;
  sqliteStore: SopSqliteStore;
  versionStore: SopVersionStore;
  syncClient: SopSyncClient;
  scheduler: SopSyncScheduler;
  /** 云端/本地规则冲突解决器（sync-conflict 模块接入点）；缺省时保持既有覆盖语义 */
  conflictResolver?: SyncConflictResolver;
  /** 冲突自动解决策略，默认 REMOTE_WINS（与既有「云端覆盖本地」行为一致） */
  conflictStrategy?: ConflictResolution;
  /** 缓存业务指标（可选） */
  metrics?: SopCacheMetrics;
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

  /** 云端规则准入关口：拒收 / 纠正的字段问题通过 `admission.getIssues()` 查询 */
  readonly admission: SopRuleAdmission;

  /** 变更应用器：所有写 registry 的动作收口在它内部，必须先过 admission */
  private applier: SopDiffApplier;

  constructor(options: SopSyncCoordinatorOptions) {
    this.registry = options.registry;
    this.clientVersion = options.clientVersion;
    this.eventBus = options.eventBus;
    this.sqliteStore = options.sqliteStore;
    this.versionStore = options.versionStore;
    this.syncClient = options.syncClient;
    this.scheduler = options.scheduler;
    const conflictPolicy = new SopConflictPolicy({
      registry: options.registry,
      resolver: options.conflictResolver,
      strategy: options.conflictStrategy,
      metrics: options.metrics,
      eventBus: options.eventBus,
    });
    this.admission = new SopRuleAdmission();
    this.applier = new SopDiffApplier({
      registry: options.registry,
      admission: this.admission,
      conflictPolicy,
      persist: (rules) => this.sqliteStore.persist(rules),
    });
  }

  // ─── 初始化 ────────────────────────────────────────────────

  /** 读取本地版本号、恢复同步状态（健康度基于磁盘上的历史成功时间，而非本进程内存），并加载本地缓存规则 */
  async initialize(): Promise<void> {
    this.localVersion = await this.versionStore.load();
    this.scheduler.hydrate(await this.versionStore.loadSyncState());

    // 缓存里可能是历史版本持久化的脏数据，恢复时同样过准入校验
    this.applier.restore(this.sqliteStore.loadAll());
  }

  // ─── 版本管理 ──────────────────────────────────────────────

  getLocalVersion(): SopVersion | null {
    return this.localVersion;
  }

  private async saveVersion(version: SopVersion): Promise<void> {
    await this.versionStore.save(version);
    this.localVersion = version;
  }

  /** 记录一次成功同步并落盘（内存态重启即丢，必须持久化） */
  private async markSuccess(): Promise<void> {
    this.scheduler.recordSync();
    await this.versionStore.saveSyncState(this.scheduler.getState());
  }

  /**
   * 记录一次失败尝试并落盘 + 打日志（不刷 lastSuccessAt：失败不能掩盖上次成功时间；此前失败路径全程静默）
   * `detail` 必带 —— 只说 "network_error" 无法区分令牌过期与服务端 5xx。
   */
  private async markFailure(reason: string, detail?: string): Promise<void> {
    this.scheduler.recordSyncFailure(reason);
    await this.versionStore.saveSyncState(this.scheduler.getState());
    console.warn(`[SopCacheManager] 同步未成功: ${reason}${detail ? ` — ${detail}` : ''}`);
  }

  // ─── 云端同步（7.4 完整同步流程） ───────────────────────────

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopFetchResult<SopVersion>> {
    return this.syncClient.checkRemoteVersion();
  }

  /**
   * 完整同步流程（7.4 节）：
   * 1. 检查版本
   * 2. 对比本地版本
   * 3. 下载增量更新
   * 4. 写入本地缓存
   * 5. 校验完整性
   */
  async syncFromCloud(): Promise<SyncResult> {
    const remote = await this.resolveRemoteVersion();
    if (!remote.ok) {
      const failed = toFailureResult(remote.failure);
      await this.markFailure(failed.reason ?? 'network_error', failed.detail);
      return failed;
    }

    const state = this.compareVersions(remote.data);
    const stateResult = await this.handleVersionState(state);
    if (stateResult) return stateResult;

    const result = await this.syncDiffOrFull(remote.data);
    // already_latest 已在 handleVersionState 内记过成功，其余未更新的结果一律视为失败尝试
    if (!result.updated && result.reason !== 'already_latest') {
      await this.markFailure(result.reason ?? 'unknown', result.detail);
    }
    return result;
  }

  /** 检查在线状态并获取云端版本；离线与云端无更新必须可区分 */
  private async resolveRemoteVersion(): Promise<SopFetchResult<SopVersion>> {
    if (!this.scheduler.isOnline) return offlineResult();
    return this.checkRemoteVersion();
  }

  /** 处理版本对比结果：latest 直接返回，reset 先清缓存；proceed 返回 null 继续 */
  private async handleVersionState(
    state: 'latest' | 'reset' | 'proceed',
  ): Promise<SyncResult | null> {
    if (state === 'latest') {
      await this.markSuccess();
      return { updated: false, reason: 'already_latest' };
    }
    if (state === 'reset') {
      console.warn('[SopCacheManager] Local version > remote version, resetting');
      await this.clearCache();
    }
    return null;
  }

  /**
   * 拉取增量 diff；取数失败或兼容性不满足时降级为全量同步。
   * 降级时必须把增量侧的原始归因带下去 —— 否则全量也失败时只剩"最后一步"的原因，
   * 真正的根因（例如 401）会被噪声盖住。
   */
  private async syncDiffOrFull(remoteVersion: SopVersion): Promise<SyncResult> {
    const fromVersion = this.localVersion?.version ?? '0.0.0';
    const diff = await this.syncClient.fetchDiff(fromVersion, remoteVersion.version);
    if (!diff.ok) {
      const cause = `增量同步失败 ${diff.failure.kind}: ${diff.failure.detail}`;
      return this.fullSync(remoteVersion, cause);
    }
    if (!isCompatibleClient(this.clientVersion, diff.data.compatibility)) {
      return compatibilityFailure(this.clientVersion, diff.data.compatibility);
    }
    try {
      return await this.applyIncremental(diff.data, fromVersion, remoteVersion);
    } catch (err) {
      console.error('[SopCacheManager] Failed to apply diff:', err);
      return this.fullSync(remoteVersion, `增量应用失败: ${describeError(err)}`);
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
    await this.markSuccess();
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
   *
   * 失败分两类且不可混同：取数失败（网络/HTTP/解码/验签）走 `toFailureResult`；
   * 取到了但落地失败归 `apply_error` —— 原实现把这两种都吞成 network_error。
   */
  private async fullSync(remoteVersion: SopVersion, cause?: string): Promise<SyncResult> {
    const rules = await this.syncClient.fetchFull(remoteVersion.version);
    if (!rules.ok) return toFailureResult(rules.failure, cause);

    try {
      // 全量替换是最危险的入口：一条坏规则会连带覆盖本地可用规则，准入校验在 applier 内部
      const admitted = this.applier.applyFull(rules.data);
      await this.saveVersion(remoteVersion);
      await this.markSuccess();
      await this.versionStore.logSync({ from: '0.0.0', to: remoteVersion.version, type: 'full' });
      this.eventBus?.emit('sop:cache-synced', {
        type: 'full',
        toVersion: remoteVersion.version,
        ruleCount: admitted.length,
        timestamp: new Date(),
      });
      return { updated: true, toVersion: remoteVersion.version, ruleCount: admitted.length };
    } catch (err) {
      return applyFailure(`全量规则落地失败: ${describeError(err)}`, cause);
    }
  }

  // ─── 应用增量更新（13.3 节） ───────────────────────────────

  /**
   * 应用增量更新（文档 13.3 节）
   * 验证版本连续性 → 事务执行 → 记录同步日志
   */
  async applyDiff(diff: SopDiff): Promise<void> {
    verifyVersionContinuity(this.localVersion, diff);
    this.applier.applyChanges(diff);
    this.applier.persistRegistry();

    await this.versionStore.logSync({
      from: diff.fromVersion,
      to: diff.version,
      added: diff.added.length,
      removed: diff.removed.length,
      modified: diff.modified.length,
      type: 'incremental',
    });
  }

  // ─── 紧急更新（7.2 节） ────────────────────────────────────

  /**
   * 紧急更新（高危规则实时推送）
   * 安全漏洞发现后立即下发，不等待每日定时同步
   */
  async emergencyUpdate(rules: SopRule[]): Promise<void> {
    // 持久化「被接纳」而非原始列表：否则坏规则会落进缓存，下次启动再被拒一次
    const admitted = this.applier.upsert(rules);
    this.sqliteStore.persist(admitted);
    await this.markSuccess();

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
}

/** 版本兼容性判定（文档 8.4 节）：主版本号比较，任一侧无法解析时按兼容处理（保守放行） */
function isCompatibleClient(clientVersion: string, requiredVersion: string): boolean {
  const localMajor = extractMajor(clientVersion);
  const requiredMajor = extractMajor(requiredVersion);
  if (localMajor === null || requiredMajor === null) return true;
  return localMajor >= requiredMajor;
}

function extractMajor(version: string): number | null {
  const match = MAJOR_VERSION.exec(version);
  return match ? parseInt(match[1], 10) : null;
}

/** 验证版本连续性：本地版本须等于 diff.fromVersion，且内容哈希须与下发 metadata.hash 一致，否则抛错 */
function verifyVersionContinuity(localVersion: SopVersion | null, diff: SopDiff): void {
  const baseVersion = localVersion?.version ?? '0.0.0';
  if (baseVersion !== diff.fromVersion) {
    throw new Error(`Version mismatch: local=${baseVersion}, expected=${diff.fromVersion}`);
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
