/** 同步策略配置选项（省略字段时使用默认值）。 */
export interface SyncPolicyOptions {
  /** 同步间隔（毫秒），默认 6 小时 */
  syncInterval?: number;
  /** 超过多少天未同步显示警告，默认 7 天 */
  staleThresholdDays?: number;
}

/**
 * createSyncPolicy — 解析同步策略并填充默认值
 *
 * 封装缓存同步的时间策略（同步间隔 + 过期阈值）及其默认值，
 * 返回已解析的配置对象（替代原先无行为的值对象类，消除 lazy-class）。
 */
export function createSyncPolicy(options: SyncPolicyOptions = {}): Required<SyncPolicyOptions> {
  return {
    syncInterval: options.syncInterval ?? 6 * 60 * 60 * 1000, // 6 小时
    staleThresholdDays: options.staleThresholdDays ?? 7,
  };
}
