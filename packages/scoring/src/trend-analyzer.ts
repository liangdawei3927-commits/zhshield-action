import type { HealthScore, ScoreTrend, TrendReport } from './types';

/**
 * TrendAnalyzer — 趋势分析算法集合（纯函数，无状态）
 *
 * 包含：线性回归、变化速率、加速度、波动率、投影、连续趋势、维度趋势
 */
export class TrendAnalyzer {
  /** 最小二乘法线性回归斜率 */
  static linearRegressionSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;
    return (n * sumXY - sumX * sumY) / denominator;
  }

  /** 变化速率 — 最近 N 个点的平均分差 */
  static computeVelocity(history: HealthScore[]): number {
    if (history.length < 2) return 0;
    const recent = history.slice(-5);
    const diffs: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      diffs.push(recent[i].overall - recent[i - 1].overall);
    }
    return diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }

  /** 加速度 — 速度的变化趋势 */
  static computeAcceleration(history: HealthScore[]): number {
    if (history.length < 4) return 0;
    const mid = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, mid);
    const secondHalf = history.slice(mid);
    const v1 = this.computeVelocity(firstHalf);
    const v2 = this.computeVelocity(secondHalf);
    return v2 - v1;
  }

  /** 波动率 — 分数标准差 */
  static computeVolatility(scores: number[]): number {
    if (scores.length < 2) return 0;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    return Math.sqrt(variance);
  }

  /** 未来 N 步投影 */
  static projectScore(scores: number[], steps: number): number | null {
    if (scores.length < 2) return null;
    const slope = this.linearRegressionSlope(scores);
    const last = scores.at(-1)!;
    return Math.max(0, Math.min(100, last + slope * steps));
  }

  /** 连续趋势统计 */
  static computeStreak(history: HealthScore[]): TrendReport['streak'] {
    if (history.length < 2) return { direction: 'stable', count: 0 };
    const last = history.at(-1)!;
    const direction = last.trend;
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].trend === direction) count++;
      else break;
    }
    return { direction, count };
  }

  /** 维度级趋势 */
  static computeDimensionTrends(history: HealthScore[], windowSize: number): TrendReport['dimensionTrends'] {
    if (history.length < 2) return [];

    const window = history.slice(-windowSize);
    const dimMap = new Map<string, number[]>();

    for (const score of window) {
      for (const dim of score.dimensions) {
        if (!dimMap.has(dim.name)) dimMap.set(dim.name, []);
        dimMap.get(dim.name)!.push(dim.score);
      }
    }

    const trends: TrendReport['dimensionTrends'] = [];
    for (const [name, scores] of dimMap) {
      const slope = this.linearRegressionSlope(scores);
      const trend: ScoreTrend =
        slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';
      const current = scores.at(-1)!;
      trends.push({ name, current, trend, slope: Math.round(slope * 1000) / 1000 });
    }
    return trends;
  }

  /** 基于上次与当前分数判断趋势方向 */
  static compareTrend(lastScore: number, current: number): ScoreTrend {
    if (current > lastScore + 1) return 'improving';
    if (current < lastScore - 1) return 'declining';
    return 'stable';
  }

  /**
   * 汇总趋势指标（返回原始值，取整由调用方负责）
   */
  static computeTrendMetrics(
    history: HealthScore[],
    windowSize: number,
    scores: number[],
  ): {
    overallTrend: ScoreTrend;
    velocity: number;
    acceleration: number;
    volatility: number;
    projectedScore: number | null;
    dimensionTrends: TrendReport['dimensionTrends'];
    streak: TrendReport['streak'];
  } {
    const slope = this.linearRegressionSlope(scores);
    const overallTrend: ScoreTrend =
      slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';

    const window = history.slice(-windowSize);
    const velocity = this.computeVelocity(window);
    const acceleration = this.computeAcceleration(window);
    const volatility = this.computeVolatility(scores);
    const projectedScore = this.projectScore(scores, 5);

    return {
      overallTrend,
      velocity,
      acceleration,
      volatility,
      projectedScore,
      dimensionTrends: this.computeDimensionTrends(history, windowSize),
      streak: this.computeStreak(history),
    };
  }
}
