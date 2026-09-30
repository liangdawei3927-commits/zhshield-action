/** 计数器指标：只增不减的累计值，labels 用于区分同一指标的不同标签组合 */
export interface CounterMetric {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: Date;
}

/** 瞬时值指标：可随采样被覆盖或增减，反映某一时刻的状态 */
export interface GaugeMetric {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: Date;
}

/** 直方图指标：value 为最新观测值，buckets 记录各区间边界的累计计数 */
export interface HistogramMetric {
  name: string;
  value: number;
  labels?: Record<string, string>;
  buckets: number[];
  timestamp: Date;
}

export class MetricsCollector {
  private counters = new Map<string, CounterMetric>();
  private gauges = new Map<string, GaugeMetric>();
  private histograms = new Map<string, HistogramMetric>();

  /**
   * 增加计数器
   */
  incrementCounter(name: string, value = 1, labels?: Record<string, string>): void {
    const key = this.makeKey(name, labels);
    const existing = this.counters.get(key);
    this.counters.set(key, {
      name,
      value: (existing?.value ?? 0) + value,
      labels,
      timestamp: new Date(),
    });
  }

  /**
   * 设置仪表盘值
   */
  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.makeKey(name, labels);
    this.gauges.set(key, { name, value, labels, timestamp: new Date() });
  }

  /**
   * 记录直方图
   */
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.makeKey(name, labels);
    const existing = this.histograms.get(key);
    const buckets = existing?.buckets ?? [10, 50, 100, 500, 1000, 5000];
    this.histograms.set(key, { name, value, labels, buckets, timestamp: new Date() });
  }

  /**
   * 获取所有指标快照
   */
  snapshot(): {
    counters: CounterMetric[];
    gauges: GaugeMetric[];
    histograms: HistogramMetric[];
  } {
    return {
      counters: [...this.counters.values()],
      gauges: [...this.gauges.values()],
      histograms: [...this.histograms.values()],
    };
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private makeKey(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return `${name}:${sorted.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }
}
