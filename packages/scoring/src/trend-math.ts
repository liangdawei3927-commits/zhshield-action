import type { HealthScore, ScoreTrend, TrendReport } from './types';

/**
 * trend-math — 趋势分析纯算法（无状态、无副作用、确定性）
 *
 * 原实现分别复制于 ScoringEngine 的私有方法与 TrendAnalyzer 的静态方法，
 * 现收敛为唯一实现，两处 import 复用，避免行为分叉。
 */

/** 最小二乘法线性回归斜率 */
export function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < n; i++) {
    // 严格索引访问下数组下标为 number | undefined：越界点按 0 计（不影响既有行为，
    // 因为 values.length === n 保证实际不会越界，此处只是让类型显式）
    const y = values[i] ?? 0;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumX2 += i * i;
  }
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

/** 变化速率 — 最近 N 个点的平均分差 */
export function computeVelocity(history: HealthScore[]): number {
  if (history.length < 2) return 0;
  const recent = history.slice(-5);
  const diffs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const current = recent[i];
    const previous = recent[i - 1];
    if (current === undefined || previous === undefined) continue;
    diffs.push(current.overall - previous.overall);
  }
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

/** 加速度 — 速度的变化趋势 */
export function computeAcceleration(history: HealthScore[]): number {
  if (history.length < 4) return 0;
  const mid = Math.floor(history.length / 2);
  const firstHalf = history.slice(0, mid);
  const secondHalf = history.slice(mid);
  const v1 = computeVelocity(firstHalf);
  const v2 = computeVelocity(secondHalf);
  return v2 - v1;
}

/** 波动率 — 分数标准差 */
export function computeVolatility(scores: number[]): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

/** 未来 N 步投影 */
export function projectScore(scores: number[], steps: number): number | null {
  if (scores.length < 2) return null;
  const slope = linearRegressionSlope(scores);
  const last = scores.at(-1)!;
  return Math.max(0, Math.min(100, last + slope * steps));
}

/** 连续趋势统计 */
export function computeStreak(history: HealthScore[]): TrendReport['streak'] {
  if (history.length < 2) return { direction: 'stable', count: 0 };
  // history.length >= 2 已保证末元素存在；仍显式判空而非用非空断言
  // （断言在运行期不提供任何保护，且会在未来重构中悄悄失效）。
  const last = history.at(-1);
  if (last === undefined) return { direction: 'stable', count: 0 };
  const direction = last.trend;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    if (point === undefined) break;
    if (point.trend === direction) count++;
    else break;
  }
  return { direction, count };
}

/** 维度级趋势 */
export function computeDimensionTrends(
  history: HealthScore[],
  windowSize: number,
): TrendReport['dimensionTrends'] {
  if (history.length < 2) return [];

  const window = history.slice(-windowSize);
  const dimMap = new Map<string, number[]>();

  for (const score of window) {
    for (const dim of score.dimensions) {
      const scores = dimMap.get(dim.name) ?? [];
      scores.push(dim.score);
      dimMap.set(dim.name, scores);
    }
  }

  const trends: TrendReport['dimensionTrends'] = [];
  for (const [name, scores] of dimMap) {
    const slope = linearRegressionSlope(scores);
    const trend: ScoreTrend = slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';
    const current = scores.at(-1)!;
    trends.push({ name, current, trend, slope: Math.round(slope * 1000) / 1000 });
  }
  return trends;
}
