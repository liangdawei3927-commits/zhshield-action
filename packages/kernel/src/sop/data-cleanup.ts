export interface CleanupConfig {
  maxEntries: number;
  maxAgeDays: number;
  keepMinimum: number;
}

export interface CleanupResult<T = unknown> {
  totalBefore: number;
  totalAfter: number;
  removed: number;
  preserved: number;
  errors: string[];
  /** 清理后保留的条目（按保留顺序），供调用方回写/裁剪存储 */
  kept: T[];
}

export class DataCleanup {
  private config: CleanupConfig;

  constructor(config?: Partial<CleanupConfig>) {
    this.config = {
      maxEntries: config?.maxEntries ?? 10000,
      maxAgeDays: config?.maxAgeDays ?? 90,
      keepMinimum: config?.keepMinimum ?? 100,
    };
  }

  /**
   * 清理数据：按时间裁剪、按大小限制
   */
  cleanup<T extends { timestamp: Date | string }>(
    entries: T[],
    options?: { maxEntries?: number; maxAgeDays?: number },
  ): CleanupResult<T> {
    const maxEntries = options?.maxEntries ?? this.config.maxEntries;
    const maxAgeDays = options?.maxAgeDays ?? this.config.maxAgeDays;
    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const totalBefore = entries.length;
    const errors: string[] = [];

    let filtered = this.filterByCutoff(entries, cutoffDate);
    filtered = this.limitByMaxEntries(filtered, maxEntries);
    filtered = this.ensureKeepMinimum(filtered, entries);

    const totalAfter = filtered.length;
    const removed = totalBefore - totalAfter;
    return {
      totalBefore,
      totalAfter,
      removed,
      preserved: totalAfter,
      errors,
      kept: filtered,
    };
  }

  /** 按时间过滤：丢弃早于截止日期的条目 */
  private filterByCutoff<T extends { timestamp: Date | string }>(
    entries: T[],
    cutoffDate: Date,
  ): T[] {
    return entries.filter(e => {
      const ts = e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp);
      return ts >= cutoffDate;
    });
  }

  /** 按大小限制：超出上限时保留最新的 */
  private limitByMaxEntries<T>(filtered: T[], maxEntries: number): T[] {
    return filtered.length > maxEntries ? filtered.slice(-maxEntries) : filtered;
  }

  /** 确保至少保留 keepMinimum 条 */
  private ensureKeepMinimum<T>(filtered: T[], entries: T[]): T[] {
    if (filtered.length < this.config.keepMinimum && entries.length >= this.config.keepMinimum) {
      return entries.slice(-this.config.keepMinimum);
    }
    return filtered;
  }

  /**
   * 版本裁剪：保留最近N个版本
   */
  trimVersions<T extends { version: number }>(
    items: T[],
    maxVersions: number,
  ): T[] {
    return items.slice(-maxVersions);
  }
}
