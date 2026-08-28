import { MetricsCollector } from '../../metrics/metrics-collector';
import type { CounterMetric, GaugeMetric, HistogramMetric } from '../../metrics/metrics-collector';
import type { ConflictResolution } from '../sync-conflict';

export interface SopCacheMetricsSnapshot {
  counters: CounterMetric[];
  gauges: GaugeMetric[];
  histograms: HistogramMetric[];
}

/**
 * SopCacheMetrics — SOP 缓存链路业务指标（MetricsCollector 的业务接入点）
 *
 * 记录：同步成功/失败与耗时、缓存命中/未命中、规则应用量、冲突解决量、清理裁剪量。
 * 指标命名沿用 Prometheus 风格（snake_case），标签用于维度拆分。
 */
export class SopCacheMetrics {
  private readonly collector: MetricsCollector;

  constructor(collector?: MetricsCollector) {
    this.collector = collector ?? new MetricsCollector();
  }

  recordSyncSuccess(durationMs: number): void {
    this.collector.incrementCounter('sop_sync_total', 1, { result: 'success' });
    this.collector.recordHistogram('sop_sync_duration_ms', durationMs);
  }

  recordSyncFailure(durationMs: number): void {
    this.collector.incrementCounter('sop_sync_total', 1, { result: 'failure' });
    this.collector.recordHistogram('sop_sync_duration_ms', durationMs);
  }

  recordCacheLookup(module: string, hit: boolean): void {
    this.collector.incrementCounter('sop_cache_lookups_total', 1, {
      module,
      result: hit ? 'hit' : 'miss',
    });
  }

  recordRulesApplied(count: number, channel: 'diff' | 'emergency'): void {
    if (count > 0) {
      this.collector.incrementCounter('sop_rules_applied_total', count, { channel });
    }
  }

  recordConflictResolved(strategy: ConflictResolution): void {
    this.collector.incrementCounter('sop_conflicts_resolved_total', 1, { strategy });
  }

  recordCleanup(removedEntries: number, remainingRules: number): void {
    if (removedEntries > 0) {
      this.collector.incrementCounter('sop_cleanup_removed_total', removedEntries);
    }
    this.collector.setGauge('sop_cache_rule_count', remainingRules);
  }

  snapshot(): SopCacheMetricsSnapshot {
    return this.collector.snapshot();
  }
}
