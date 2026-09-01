import type { SyncResult } from '../_meta/sop-types';
import type { SyncPolicyOptions } from './sop-sync-policy';

/**
 * SopSyncScheduler — 同步调度与健康度评估
 *
 * 负责后台定时同步调度、在线状态与降级健康度（Level 0-4）/过期判断。
 * 同步编排器在每次成功同步后调用 recordSync() 记录同步时间。
 */
export class SopSyncScheduler {
  private lastSyncTime: Date | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private online = true;

  constructor(private readonly syncPolicy: Required<SyncPolicyOptions>) {}

  /** 当前是否在线 */
  get isOnline(): boolean {
    return this.online;
  }

  // ─── 同步调度 ──────────────────────────────────────────────

  /**
   * 启动后台定时同步（7.5 节 触发方式 2）
   */
  startPeriodicSync(onSync: () => Promise<SyncResult>): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(() => {
      void onSync();
    }, this.syncPolicy.syncInterval);
  }

  /**
   * 停止定时同步
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * 设置在线状态
   */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /**
   * 记录最近一次成功同步时间（由同步编排器调用）
   */
  recordSync(): void {
    this.lastSyncTime = new Date();
  }

  // ─── 降级策略（10.5 节） ───────────────────────────────────

  /**
   * 获取当前同步状态级别
   * Level 0: 正常  Level 1-3: 降级  Level 4: 严重过期
   */
  getSyncHealthLevel(): 0 | 1 | 2 | 3 | 4 {
    if (!this.lastSyncTime) return 4;

    const daysSinceSync = (Date.now() - this.lastSyncTime.getTime()) / (24 * 60 * 60 * 1000);

    if (daysSinceSync <= 1) return 0;
    if (daysSinceSync <= 3) return 1;
    if (daysSinceSync <= 7) return 2;
    if (daysSinceSync <= 14) return 3;
    return 4;
  }

  /**
   * 判断规则是否可能过期（需要显示警告）
   */
  isStale(): boolean {
    if (!this.lastSyncTime) return true;
    const daysSinceSync = (Date.now() - this.lastSyncTime.getTime()) / (24 * 60 * 60 * 1000);
    return daysSinceSync > this.syncPolicy.staleThresholdDays;
  }
}
