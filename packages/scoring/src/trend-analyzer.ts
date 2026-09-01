import {
  linearRegressionSlope,
  computeVelocity,
  computeAcceleration,
  computeVolatility,
  projectScore,
  computeStreak,
  computeDimensionTrends,
} from './trend-math';
import type { HealthScore, ScoreTrend, TrendReport } from './types';

/**
 * TrendAnalyzer — 趋势分析算法集合（纯函数，无状态）
 *
 * 包含：线性回归、变化速率、加速度、波动率、投影、连续趋势、维度趋势
 *
 * 算法实现统一收敛于 ./trend-math（与 ScoringEngine 共享唯一实现）。
 */
export class TrendAnalyzer {
  /** 最小二乘法线性回归斜率 */
  static linearRegressionSlope(values: number[]): number {
    return linearRegressionSlope(values);
  }

  /** 变化速率 — 最近 N 个点的平均分差 */
  static computeVelocity(history: HealthScore[]): number {
    return computeVelocity(history);
  }

  /** 加速度 — 速度的变化趋势 */
  static computeAcceleration(history: HealthScore[]): number {
    return computeAcceleration(history);
  }

  /** 波动率 — 分数标准差 */
  static computeVolatility(scores: number[]): number {
    return computeVolatility(scores);
  }

  /** 未来 N 步投影 */
  static projectScore(scores: number[], steps: number): number | null {
    return projectScore(scores, steps);
  }

  /** 连续趋势统计 */
  static computeStreak(history: HealthScore[]): TrendReport['streak'] {
    return computeStreak(history);
  }

  /** 维度级趋势 */
  static computeDimensionTrends(
    history: HealthScore[],
    windowSize: number,
  ): TrendReport['dimensionTrends'] {
    return computeDimensionTrends(history, windowSize);
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
