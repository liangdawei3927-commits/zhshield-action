import type { EventBus } from '../../bus';
import type { SopRegistry } from '../_meta/sop-registry';
import type { DataCleanup, CleanupConfig } from '../data-cleanup';
import type { SopSqliteStore } from './sop-sqlite-store';
import type { SopVersionStore } from './sop-version-store';
import type { SopCacheMetrics } from './sop-cache-metrics';

/** 默认清理配置（与 DataCleanup 内建默认一致，供注入方复用） */
export const DEFAULT_SOP_CLEANUP_CONFIG: Readonly<CleanupConfig> = {
  maxEntries: 10000,
  maxAgeDays: 90,
  keepMinimum: 100,
};

export type MaintenanceTrigger = 'init' | 'diff' | 'emergency';

export interface MaintenanceOutcome {
  trigger: MaintenanceTrigger;
  rulesBefore: number;
  rulesAfter: number;
  rulesRemoved: number;
  logEntriesBefore: number;
  logEntriesAfter: number;
  logEntriesRemoved: number;
}

export interface SopCacheMaintenanceOptions {
  registry: SopRegistry;
  sqliteStore: SopSqliteStore;
  versionStore: SopVersionStore;
  cleanup: DataCleanup;
  cleanupConfig?: Partial<CleanupConfig>;
  metrics?: SopCacheMetrics;
  eventBus?: EventBus;
}

/**
 * SopCacheMaintenance — 缓存自动维护（DataCleanup 的业务接入点）
 *
 * - 规则条目：按「最新 N 个版本」数量上限裁剪（trimVersions），keepMinimum 下限保护；
 *   不做时间淘汰 —— 本地缓存是桌面端唯一规则来源，活跃规则不因创建较早而被误删。
 * - sync.log：按 maxAgeDays 时间淘汰 + 数量上限裁剪（cleanup）。
 *
 * 维护是尽力而为：异常在 run() 内部兜底（返回 null），不阻塞同步主流程。
 */
export class SopCacheMaintenance {
  private readonly registry: SopRegistry;
  private readonly sqliteStore: SopSqliteStore;
  private readonly versionStore: SopVersionStore;
  private readonly cleanup: DataCleanup;
  private readonly metrics?: SopCacheMetrics;
  private readonly eventBus?: EventBus;
  private readonly config: Required<CleanupConfig>;

  constructor(options: SopCacheMaintenanceOptions) {
    this.registry = options.registry;
    this.sqliteStore = options.sqliteStore;
    this.versionStore = options.versionStore;
    this.cleanup = options.cleanup;
    this.metrics = options.metrics;
    this.eventBus = options.eventBus;
    this.config = { ...DEFAULT_SOP_CLEANUP_CONFIG, ...options.cleanupConfig };
  }

  async run(trigger: MaintenanceTrigger): Promise<MaintenanceOutcome | null> {
    try {
      const rulePrune = await this.pruneRules();
      const logPrune = await this.pruneSyncLog();

      const outcome: MaintenanceOutcome = {
        trigger,
        rulesBefore: rulePrune.before,
        rulesAfter: rulePrune.after,
        rulesRemoved: rulePrune.removed,
        logEntriesBefore: logPrune.before,
        logEntriesAfter: logPrune.after,
        logEntriesRemoved: logPrune.removed,
      };

      this.metrics?.recordCleanup(outcome.rulesRemoved + outcome.logEntriesRemoved, outcome.rulesAfter);
      this.eventBus?.emit('sop:maintenance-completed', { ...outcome, timestamp: new Date() }).catch(() => {});

      return outcome;
    } catch {
      return null;
    }
  }

  private async pruneRules(): Promise<{ before: number; after: number; removed: number }> {
    const rules = this.registry.getAll();
    const before = rules.length;
    if (before <= this.config.maxEntries) {
      return { before, after: before, removed: 0 };
    }

    const sorted = rules.toSorted((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const kept = this.cleanup.trimVersions(
      sorted.map((rule) => ({ version: rule.updatedAt.getTime(), rule })),
      this.config.maxEntries,
    );

    // keepMinimum 下限保护：裁剪后剩余不足下限时放弃本次裁剪
    if (kept.length < this.config.keepMinimum) {
      return { before, after: before, removed: 0 };
    }

    const keptIds = new Set(kept.map((entry) => entry.rule.id));
    const removedRules = rules.filter((rule) => !keptIds.has(rule.id));
    for (const rule of removedRules) {
      this.registry.remove(rule.id);
    }
    this.sqliteStore.remove(removedRules.map((rule) => rule.id));

    return { before, after: kept.length, removed: removedRules.length };
  }

  private async pruneSyncLog(): Promise<{ before: number; after: number; removed: number }> {
    const entries = await this.versionStore.readSyncLog();
    const before = entries.length;
    if (before === 0) {
      return { before: 0, after: 0, removed: 0 };
    }

    const result = this.cleanup.cleanup(entries, { maxAgeDays: this.config.maxAgeDays });
    if (result.removed > 0) {
      await this.versionStore.writeSyncLog(result.kept);
    }
    return { before, after: result.totalAfter, removed: result.removed };
  }
}
