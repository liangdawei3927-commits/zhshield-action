import type Database from 'better-sqlite3';
import { saveScore, getLatestScore, getScoreHistory } from '@zh/db';
import { isReferenceDimension } from '@zh/shared';
import {
  linearRegressionSlope,
  computeVelocity,
  computeAcceleration,
  computeVolatility,
  projectScore,
  computeStreak,
  computeDimensionTrends,
} from './trend-math';
import type {
  HealthScore,
  DimensionScore,
  ScoreTrend,
  TrendReport,
  RedLineInfo,
  ScoreCoverage,
} from './types';
import { SCORE_VERSION } from './redline';

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
 * true = 该维度参与总分（计分维度且已检测）。
 *
 * 排除两类：
 * - `status='not-run'`：没检测，禁止按 0 或满分计（spec C）；
 * - `excludedFromOverall` / 名字属于参考维度：检测了但只作参考（techdebt）。
 *
 * 按名字兜底是给旧记录用的：旧 `dimensions` JSON 没有 `excludedFromOverall` 字段，
 * 但 techdebt 的语义在新旧口径里都不该计总分。
 */
export function isOverallDimension(d: DimensionScore): boolean {
  return d.status !== 'not-run' && d.excludedFromOverall !== true && !isReferenceDimension(d.name);
}

/** 覆盖度：计分维度里实际检测了几个（参考维度不计入 total） */
export function computeCoverage(dimensionScores: readonly DimensionScore[]): ScoreCoverage {
  const scored = dimensionScores.filter((d) => !isReferenceDimension(d.name));
  const run = scored.filter((d) => d.status !== 'not-run').length;
  return { run, total: scored.length, complete: run === scored.length };
}

/** 加权总评：只按计分且已检测的维度归一化（spec C：未检测域禁止按满分计；techdebt 参考化） */
function computeOverall(dimensionScores: DimensionScore[]): number {
  const active = dimensionScores.filter(isOverallDimension);
  const weightSum = active.reduce((s, d) => s + d.weight, 0);
  return weightSum > 0 ? active.reduce((s, d) => s + d.score * d.weight, 0) / weightSum : 0;
}

/** 等级排序：A 最好、D 最差；用于短板封顶取更差的那个 */
const GRADE_RANK: Record<HealthScore['grade'], number> = { A: 0, B: 1, C: 2, D: 3 };
const RANK_GRADE: HealthScore['grade'][] = ['A', 'B', 'C', 'D'];

/** 红线封顶（十域评分章程）：任一 critical 事实存在时总评 ≤ cap，一票压制 */
function applyRedLineCap(
  overall: number,
  redLine?: RedLineInfo | null,
): { overall: number; appliedRedLine: RedLineInfo | undefined } {
  if (redLine?.capped) {
    return { overall: Math.min(overall, redLine.cap), appliedRedLine: redLine };
  }
  return { overall, appliedRedLine: undefined };
}

/**
 * 等级 = 基础线（A≥90 / B≥75 / C≥60 / D<60）+ 短板封顶。
 *
 * 只做平均分会让「9 类满分 + 1 类 0 分」继续显示 A，普通用户不会去看最弱那类；
 * 因此短板直接封顶等级：任一计分类 <60 → 最高 C；任一 <75 → 最高 B。
 * 覆盖不足时的等级由 UI 决定不展示（见 `computeCoverage`），这里仍返回可复算的等级。
 */
function computeGrade(overall: number, dimensionScores: readonly DimensionScore[]): HealthScore['grade'] {
  const base: HealthScore['grade'] =
    overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : 'D';
  const scored = dimensionScores.filter(isOverallDimension);
  if (scored.length === 0) return base;

  const weakest = Math.min(...scored.map((d) => d.score));
  const ceil: HealthScore['grade'] = weakest < 60 ? 'C' : weakest < 75 ? 'B' : 'A';
  const rank = Math.max(GRADE_RANK[base], GRADE_RANK[ceil]);
  return RANK_GRADE[rank]!;
}

/**
 * 只读总评：与 `ScoringEngine.calculate` **同一套**加权 / 红线封顶 / 分级规则，
 * 但**不落库、不写历史、不算趋势**（2026-10-24 新增）。
 *
 * 为什么单独开一个入口：报告中心总览与分类页要显示「当下」的分，而 `calculate`
 * 一调用就往 `scores` 表插一条 —— 用它出实时分等于把「打开页面」当成一次评估，
 * 历史曲线会被浏览行为污染（实测过：每 5~6 分钟一条记录里混着扫描记录与补记记录）。
 *
 * 规则实现直接复用上面三个私有函数，**不得**在这里另写一份加权公式：
 * 第三套算法会让「总分 ≠ 十张卡加权」这类问题以更隐蔽的形式复发。
 */
export function computeOverallSnapshot(
  dimensionScores: readonly DimensionScore[],
  redLine?: RedLineInfo | null,
): {
  overall: number;
  grade: HealthScore['grade'];
  coverage: ScoreCoverage;
  redLine?: RedLineInfo;
} {
  const copies = [...dimensionScores];
  const raw = computeOverall(copies);
  const { overall, appliedRedLine } = applyRedLineCap(raw, redLine);
  return {
    overall: Math.round(overall * 100) / 100,
    grade: computeGrade(overall, copies),
    coverage: computeCoverage(copies),
    ...(appliedRedLine ? { redLine: appliedRedLine } : {}),
  };
}

function buildScore(params: {
  projectId: string;
  dimensionScores: DimensionScore[];
  overall: number;
  grade: HealthScore['grade'];
  trend: ScoreTrend;
  appliedRedLine: RedLineInfo | undefined;
}): HealthScore {
  return {
    projectId: params.projectId,
    timestamp: new Date(),
    overall: Math.round(params.overall * 100) / 100,
    grade: params.grade,
    dimensions: params.dimensionScores,
    trend: params.trend,
    scoreVersion: SCORE_VERSION,
    coverage: computeCoverage(params.dimensionScores),
    ...(params.appliedRedLine ? { redLine: params.appliedRedLine } : {}),
  };
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

  calculate(
    projectId: string,
    dimensionScores: DimensionScore[],
    redLine?: RedLineInfo | null,
  ): HealthScore {
    const overall = computeOverall(dimensionScores);
    const { overall: cappedOverall, appliedRedLine } = applyRedLineCap(overall, redLine);
    const grade = computeGrade(cappedOverall, dimensionScores);
    const trend = this.computeTrend(projectId, cappedOverall);
    const score = buildScore({
      projectId,
      dimensionScores,
      overall: cappedOverall,
      grade,
      trend,
      appliedRedLine,
    });
    this.persistScore(projectId, score);
    this.recordHistory(projectId, score);
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
    const streak = computeStreak(history);
    const dimensionTrends = computeDimensionTrends(history, windowSize);
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
    const slope = linearRegressionSlope(scores);
    const velocity = computeVelocity(window);
    const acceleration = computeAcceleration(window);
    const volatility = computeVolatility(scores);
    const projectedScore = projectScore(scores, 5);
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
    score_version?: number | null;
  }): HealthScore {
    const dimensions = JSON.parse(row.dimensions) as DimensionScore[];
    return {
      projectId: row.project_id,
      timestamp: new Date(row.created_at),
      overall: row.overall,
      grade: row.grade as HealthScore['grade'],
      dimensions,
      trend: row.trend as ScoreTrend,
      // 旧记录没有该列（null/undefined）→ 不冒充版本号，趋势/归因据此判「不可比」
      ...(typeof row.score_version === 'number' ? { scoreVersion: row.score_version } : {}),
      coverage: computeCoverage(dimensions),
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

  private persistScore(projectId: string, score: HealthScore): void {
    if (!this.db) return;
    saveScore(this.db, {
      projectId,
      overall: score.overall,
      grade: score.grade,
      dimensions: JSON.stringify(score.dimensions),
      trend: score.trend,
      scoreVersion: score.scoreVersion ?? SCORE_VERSION,
    });
  }

  private recordHistory(projectId: string, score: HealthScore): void {
    const scores = this.history.get(projectId) ?? [];
    scores.push(score);
    this.history.set(projectId, scores);
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
