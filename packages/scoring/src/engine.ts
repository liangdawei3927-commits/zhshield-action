import type Database from 'better-sqlite3';
import { saveScore, getLatestScore, getScoreHistory, } from '@zh/db';
import type { HealthScore, DimensionScore, ScoreTrend, TrendReport } from './types';

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
    const grade: HealthScore['grade'] = overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : 'D';
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

    const window = history.slice(-windowSize);
    const scores = window.map((s) => s.overall);
    const slope = this.linearRegressionSlope(scores);
    const velocity = this.computeVelocity(window);
    const acceleration = this.computeAcceleration(window);
    const volatility = this.computeVolatility(scores);
    const projectedScore = this.projectScore(scores, 5);

    const overallTrend: ScoreTrend =
      slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable';

    const streak = this.computeStreak(history);
    const dimensionTrends = this.computeDimensionTrends(history, windowSize);
    const insights = this.generateInsights({ scores, velocity, volatility, streak, dimensionTrends });

    return {
      projectId,
      current,
      overallTrend,
      velocity: Math.round(velocity * 1000) / 1000,
      acceleration: Math.round(acceleration * 1000) / 1000,
      volatility: Math.round(volatility * 1000) / 1000,
      projectedScore: projectedScore !== null ? Math.round(projectedScore * 100) / 100 : null,
      dimensionTrends,
      insights,
      streak,
    };
  }

  private rowToScore(row: {
    project_id: string; overall: number; grade: string;
    dimensions: string; trend: string; created_at: string;
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
  private computeDimensionTrends(history: HealthScore[], windowSize: number): TrendReport['dimensionTrends'] {
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

    if (current >= 90) insights.push('项目健康度优秀（A 级），保持当前实践');
    else if (current >= 75) insights.push('项目健康度良好（B 级），有提升空间');
    else if (current >= 60) insights.push('项目健康度一般（C 级），建议关注薄弱环节');
    else insights.push('项目健康度较差（D 级），需要立即改进');

    if (velocity > 2) insights.push(`评分上升趋势明显（速度 +${velocity.toFixed(1)}/次）`);
    else if (velocity < -2) insights.push(`评分持续下降（速度 ${velocity.toFixed(1)}/次），需要关注`);

    if (volatility > 10) insights.push('评分波动较大，说明改进不稳定');
    else if (volatility < 3) insights.push('评分变化平稳，项目状态稳定');

    if (streak.count >= 3) {
      const dir = streak.direction === 'improving' ? '连续改善' : streak.direction === 'declining' ? '连续退化' : '保持稳定';
      insights.push(`${dir}已持续 ${streak.count} 次评估`);
    }

    const declining = dimensionTrends.filter((d) => d.trend === 'declining');
    if (declining.length > 0) {
      insights.push(`需要关注的维度: ${declining.map((d) => d.name).join('、')}`);
    }

    return insights;
  }
}
