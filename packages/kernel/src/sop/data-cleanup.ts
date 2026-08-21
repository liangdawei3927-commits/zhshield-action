export interface CleanupConfig {
  maxEntries: number;
  maxAgeDays: number;
  keepMinimum: number;
}

export interface CleanupResult {
  totalBefore: number;
  totalAfter: number;
  removed: number;
  preserved: number;
  errors: string[];
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
  ): CleanupResult {
    const maxEntries = options?.maxEntries ?? this.config.maxEntries;
    const maxAgeDays = options?.maxAgeDays ?? this.config.maxAgeDays;
    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

    const totalBefore = entries.length;
    const errors: string[] = [];

    // 按时间过滤
    let filtered = entries.filter(e => {
      const ts = e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp);
      return ts >= cutoffDate;
    });

    // 按大小限制（保留最新的）
    if (filtered.length > maxEntries) {
      filtered = filtered.slice(-maxEntries);
    }

    // 确保至少保留 keepMinimum 条
    if (filtered.length < this.config.keepMinimum && entries.length >= this.config.keepMinimum) {
      filtered = entries.slice(-this.config.keepMinimum);
    }

    const totalAfter = filtered.length;
    const removed = totalBefore - totalAfter;

    return {
      totalBefore,
      totalAfter,
      removed,
      preserved: totalAfter,
      errors,
    };
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
