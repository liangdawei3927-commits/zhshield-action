import type Database from 'better-sqlite3';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import { saveScore, getLatestScore, getScoreHistory, getProject, createProject } from '@zh/db';
import type { HealthScore, DimensionScore, ScoreTrend, TrendReport } from './types';
import { TrendAnalyzer } from './trend-analyzer';
import { InsightGenerator } from './insight-generator';

/** 趋势指标汇总 — TrendAnalyzer.computeTrendMetrics 的返回类型 */
type TrendMetrics = ReturnType<typeof TrendAnalyzer.computeTrendMetrics>;

/**
 * 评分引擎 v2 — 支持多点趋势分析、变化速率、维度趋势
 *
 * 职责：
 * - 分数计算与持久化（calculate / getCurrent / getHistory）
 * - 趋势报告装配（getTrendReport）
 * 趋势算法见 TrendAnalyzer，洞察生成见 InsightGenerator
 */
export class ScoringEngine {
  private db: Database.Database | null;
  private history = new Map<string, HealthScore[]>();
  private insightGenerator = new InsightGenerator();

  constructor(db?: Database.Database) {
    this.db = db ?? null;
  }

  calculate(projectId: string, dimensionScores: DimensionScore[]): HealthScore {
    const totalWeight = dimensionScores.reduce((sum, d) => sum + d.weight, 0);
    const weightScale = totalWeight === 0 ? 1 : 1 / totalWeight;
    const overall = Math.max(
      0,
      Math.min(
        100,
        dimensionScores.reduce((sum, d) => sum + d.score * d.weight * weightScale, 0),
      ),
    );
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
      this.ensureProject(projectId);
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
   * 确保项目行存在 — scores.project_id 外键引用 projects(id)，
   * 若项目未注册（如仅做体检未走项目管理流程）先补齐占位行，避免落库抛外键异常
   */
  private ensureProject(projectId: string): void {
    if (!this.db || getProject(this.db, projectId)) return;
    createProject(this.db, { id: projectId, name: projectId, path: projectId });
  }

  /**
   * 生成趋势报告 — 数据加载 + 指标计算 + 洞察生成与装配
   */
  getTrendReport(projectId: string, windowSize = 10, locale?: LanguageCode): TrendReport {
    const history = this.getHistory(projectId);
    const current = this.getCurrent(projectId);

    if (!current || history.length === 0) {
      return this.buildEmptyReport(projectId, locale);
    }

    const { scores, metrics } = this.computeWindowMetrics(history, windowSize);
    return this.assembleReport(projectId, current, scores, metrics, locale);
  }

  /**
   * 计算窗口内趋势指标 — 窗口切分 + 指标汇总
   */
  private computeWindowMetrics(
    history: HealthScore[],
    windowSize: number,
  ): { scores: number[]; metrics: TrendMetrics } {
    const scores = history.slice(-windowSize).map((s) => s.overall);
    return { scores, metrics: TrendAnalyzer.computeTrendMetrics(history, windowSize, scores) };
  }

  /**
   * 装配趋势报告 — 洞察生成 + 数值取整
   */
  private assembleReport(
    projectId: string,
    current: HealthScore,
    scores: number[],
    metrics: TrendMetrics,
    locale?: LanguageCode,
  ): TrendReport {
    const insights = this.insightGenerator.generate({
      scores,
      velocity: metrics.velocity,
      volatility: metrics.volatility,
      streak: metrics.streak,
      dimensionTrends: metrics.dimensionTrends,
    }, locale);

    return {
      projectId,
      current,
      overallTrend: metrics.overallTrend,
      velocity: Math.round(metrics.velocity * 1000) / 1000,
      acceleration: Math.round(metrics.acceleration * 1000) / 1000,
      volatility: Math.round(metrics.volatility * 1000) / 1000,
      projectedScore: metrics.projectedScore !== null ? Math.round(metrics.projectedScore * 100) / 100 : null,
      dimensionTrends: metrics.dimensionTrends,
      insights,
      streak: metrics.streak,
    };
  }

  private buildEmptyReport(projectId: string, locale?: LanguageCode): TrendReport {
    return {
      projectId,
      current: null,
      overallTrend: 'stable',
      velocity: 0,
      acceleration: 0,
      volatility: 0,
      projectedScore: null,
      dimensionTrends: [],
      insights: [translate('engine.scoring.insight.empty', locale ?? DEFAULT_LANGUAGE)],
      streak: { direction: 'stable', count: 0 },
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
      dimensions: parseDimensions(row.dimensions),
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
    return TrendAnalyzer.compareTrend(lastScore, current);
  }
}

function parseDimensions(raw: string): DimensionScore[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDimensionScoreArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isDimensionScoreArray(value: unknown): value is DimensionScore[] {
  if (!Array.isArray(value)) return false;
  return value.every(isDimensionScore);
}

function isDimensionScore(d: unknown): d is DimensionScore {
  if (typeof d !== 'object' || d === null) return false;
  return (
    'name' in d && typeof d.name === 'string' &&
    'score' in d && typeof d.score === 'number' &&
    'weight' in d && typeof d.weight === 'number' &&
    'issues' in d && typeof d.issues === 'number'
  );
}
