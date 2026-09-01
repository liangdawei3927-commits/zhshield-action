import type Database from 'better-sqlite3';
import { saveScore, getLatestScore, getScoreHistory } from '@zh/db';
import type { HealthScore, DimensionScore, ScoreTrend, TrendReport } from './types';

function emptyTrendReport(projectId: string): TrendReport {
  return {
    projectId,
    current: null,
    overallTrend: 'stable',
    velocity: 0,
    acceleration: 0,
    volatility: 0,
    projectedScore: null,
    dimensionTrends: [],
    insights: ['暂无历史数据，无法生成趋势分析'],
    streak: { direction: 'stable', count: 0 },
  };
}

function pushIfDefined(list: string[], item: string | undefined): void {
  if (item !== undefined) list.push(item);
}

function healthInsight(current: number): string | undefined {
  if (current >= 90) return '项目健康度优秀（A 级），保持当前实践';
  if (current >= 75) return '项目健康度良好（B 级），有提升空间';
  if (current >= 60) return '项目健康度一般（C 级），建议关注薄弱环节';
  return '项目健康度较差（D 级），需要立即改进';
}

function velocityInsight(velocity: number): string | undefined {
  if (velocity > 2) return `评分上升趋势明显（速度 +${velocity.toFixed(1)}/次）`;
  if (velocity < -2) return `评分持续下降（速度 ${velocity.toFixed(1)}/次），需要关注`;
  return undefined;
}

function volatilityInsight(volatility: number): string | undefined {
  if (volatility > 10) return '评分波动较大，说明改进不稳定';
  if (volatility < 3) return '评分变化平稳，项目状态稳定';
  return undefined;
}

function streakInsight(streak: TrendReport['streak']): string | undefined {
  if (streak.count < 3) return undefined;
  const dir =
    streak.direction === 'improving'
      ? '连续改善'
      : streak.direction === 'declining'
        ? '连续退化'
        : '保持稳定';
  return `${dir}已持续 ${streak.count} 次评估`;
}

function decliningDimensionsInsight(
  dimensionTrends: TrendReport['dimensionTrends'],
): string | undefined {
  const declining = dimensionTrends.filter((d) => d.trend === 'declining');
  if (declining.length === 0) return undefined;
  return `需要关注的维度: ${declining.map((d) => d.name).join('、')}`;
}

/**
 * 评分引擎 v2 — 支持多点趋势分析、变化速率、维度趋势
 */
export class ScoringEngine {
  private db: Database.Database | null;
  private history = new Map<string, HealthScore[]>();

  constructor(db?: Database.Database) {
    this.db = db ?? null;
  }

  calculate(projectId: string, dimensionScores: DimensionScore[]): HealthScore {
    const overall = dimensionScores.reduce((sum, d) => sum + d.score * d.weight, 0);
    const grade: HealthScore['grade'] =
      overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : 'D';
    const trend = this.computeTrend(projectId, overall);

    const score: HealthScore = {
      projectId,
      timestamp: new Date(),
      overall: Math.round(overall * 100) / 100,
      grade,
      dimensions: dimensionScores,
      trend,
    };

    if (this.db) {
      saveScore(this.db, {
        projectId,
        overall: score.overall,
        grade,
        dimensions: JSON.stringify(dimensionScores),
        trend,
      });
    }

    if (!this.history.has(projectId)) this.history.set(projectId, []);
    this.history.get(projectId)!.push(score);

    return score;
  }

  getCurrent(projectId: string): HealthScore | undefined {
    if (this.db) {
      const row = getLatestScore(this.db, projectId);
      if (row) return this.rowToScore(row);
    }
    const scores = this.history.get(projectId);
    return scores?.at(-1);
  }

  getHistory(projectId: string): HealthScore[] {
    if (this.db) {
      const rows = getScoreHistory(this.db, projectId, 100);
      return rows.map((r) => this.rowToScore(r));
    }
    return this.history.get(projectId) || [];
  }

  /**
   * 生成趋势报告 — 多点分析 + 维度趋势 + 变化速率 + 投影
   */
  getTrendReport(projectId: string, windowSize = 10): TrendReport {
    const history = this.getHistory(projectId);
    const current = this.getCurrent(projectId);
    if (!current || history.length === 0) {
      return emptyTrendReport(projectId);
    }
    const window = history.slice(-windowSize);
    const metrics = this.computeTrendMetrics(window);
    const streak = this.computeStreak(history);
    const dimensionTrends = this.computeDimensionTrends(history, windowSize);
    const insights = this.generateInsights({
      scores: metrics.scores,
      velocity: metrics.velocity,
      volatility: metrics.volatility,
      streak,
      dimensionTrends,
    });
    return {
      projectId,
      current,
      overallTrend: metrics.overallTrend,
      velocity: Math.round(metrics.velocity * 1000) / 1000,
      acceleration: Math.round(metrics.acceleration * 1000) / 1000,
      volatility: Math.round(metrics.volatility * 1000) / 1000,
      projectedScore:
        metrics.projectedScore !== null ? Math.round(metrics.projectedScore * 100) / 100 : null,
      dimensionTrends,
      insights,
      streak,
    };
  }

  private computeTrendMetrics(window: HealthScore[]): {
    scores: number[];
    slope: number;
    velocity: number;
    acceleration: number;
    volatility: number;
    projectedScore: number | null;
    overallTrend: ScoreTrend;
  } {
    const scores = window.map((s) => s.overall);
    const slope = this.linearRegressionSlope(scores);
    const velocity = this.computeVelocity(window);
    const acceleration = this.computeAcceleration(window);
    const volatility = this.computeVolatility(scores);
    const projectedScore = this.projectScore(scores, 5);
    const overallTrend: ScoreTrend =
      slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';
    return { scores, slope, velocity, acceleration, volatility, projectedScore, overallTrend };
  }

  private rowToScore(row: {
    project_id: string;
    overall: number;
    grade: string;
    dimensions: string;
    trend: string;
    created_at: string;
  }): HealthScore {
    return {
      projectId: row.project_id,
      timestamp: new Date(row.created_at),
      overall: row.overall,
      grade: row.grade as HealthScore['grade'],
      dimensions: JSON.parse(row.dimensions) as DimensionScore[],
      trend: row.trend as ScoreTrend,
    };
  }

  private computeTrend(projectId: string, current: number): ScoreTrend {
    let lastScore: number | undefined;

    if (this.db) {
      const row = getLatestScore(this.db, projectId);
      if (row) lastScore = row.overall;
    }

    if (lastScore === undefined) {
      const prev = this.history.get(projectId);
      if (prev && prev.length > 0) {
        lastScore = prev.at(-1)?.overall;
      }
    }

    if (lastScore === undefined) return 'stable';
    if (current > lastScore + 1) return 'improving';
    if (current < lastScore - 1) return 'declining';
    return 'stable';
  }

  // ─── 趋势分析算法 ────────────────────────────────────────

  /** 最小二乘法线性回归斜率 */
  private linearRegressionSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
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
  private computeVelocity(history: HealthScore[]): number {
    if (history.length < 2) return 0;
    const recent = history.slice(-5);
    const diffs: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      diffs.push(recent[i].overall - recent[i - 1].overall);
    }
    return diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }

  /** 加速度 — 速度的变化趋势 */
  private computeAcceleration(history: HealthScore[]): number {
    if (history.length < 4) return 0;
    const mid = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, mid);
    const secondHalf = history.slice(mid);
    const v1 = this.computeVelocity(firstHalf);
    const v2 = this.computeVelocity(secondHalf);
    return v2 - v1;
  }

  /** 波动率 — 分数标准差 */
  private computeVolatility(scores: number[]): number {
    if (scores.length < 2) return 0;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    return Math.sqrt(variance);
  }

  /** 未来 N 步投影 */
  private projectScore(scores: number[], steps: number): number | null {
    if (scores.length < 2) return null;
    const slope = this.linearRegressionSlope(scores);
    const last = scores.at(-1)!;
    return Math.max(0, Math.min(100, last + slope * steps));
  }

  /** 连续趋势统计 */
  private computeStreak(history: HealthScore[]): TrendReport['streak'] {
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
  private computeDimensionTrends(
    history: HealthScore[],
    windowSize: number,
  ): TrendReport['dimensionTrends'] {
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
      const trend: ScoreTrend = slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';
      const current = scores.at(-1)!;
      trends.push({ name, current, trend, slope: Math.round(slope * 1000) / 1000 });
    }
    return trends;
  }

  /** 洞察生成 */
  private generateInsights({
    scores,
    velocity,
    volatility,
    streak,
    dimensionTrends,
  }: {
    scores: number[];
    velocity: number;
    volatility: number;
    streak: TrendReport['streak'];
    dimensionTrends: TrendReport['dimensionTrends'];
  }): string[] {
    const insights: string[] = [];
    const current = scores.at(-1)!;
    pushIfDefined(insights, healthInsight(current));
    pushIfDefined(insights, velocityInsight(velocity));
    pushIfDefined(insights, volatilityInsight(volatility));
    pushIfDefined(insights, streakInsight(streak));
    pushIfDefined(insights, decliningDimensionsInsight(dimensionTrends));
    return insights;
  }
}
