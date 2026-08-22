import type {
  DimensionScore,
  ScoreGrade,
  ScoringRuleContext,
  ScoringConfig,
  ScoringResult,
} from './types';
import { getDefaultScoringConfig } from './scoring-config';

/**
 * 上下文评分引擎（导出为 ContextScoringEngine，与 engine.ts 的趋势引擎互补）
 * 支持可配置维度、正向激励、上下文感知
 */
export class ScoringEngine {
  private config: ScoringConfig;

  constructor(config?: ScoringConfig) {
    this.config = config ?? getDefaultScoringConfig();
  }

  score(context: ScoringRuleContext): ScoringResult {
    const dimensionResults = this.config.dimensions.map(dim => {
      const baseScore = 100;
      const negativePoints = this.calculateNegativePoints(dim.id, context);
      const positivePoints = this.calculatePositivePoints(dim.id, context);
      const score = Math.max(0, Math.min(100, baseScore - negativePoints + positivePoints));

      return {
        dimension: dim.id,
        score,
        weight: dim.weight,
        positive: positivePoints,
        negative: negativePoints,
        issues: context.findings.filter(f => f.category === dim.id).length,
      };
    });

    const overall = dimensionResults.reduce(
      (sum, d) => sum + d.score * d.weight,
      0,
    );

    const positivePoints = dimensionResults.reduce((sum, d) => sum + d.positive, 0);
    const negativePoints = dimensionResults.reduce((sum, d) => sum + d.negative, 0);

    const dimensions: DimensionScore[] = dimensionResults.map(d => ({
      name: d.dimension,
      weight: d.weight,
      score: d.score,
      issues: d.issues,
    }));

    return {
      overall: Math.round(overall * 100) / 100,
      grade: this.toGrade(overall),
      dimensions,
      positivePoints,
      negativePoints,
      details: dimensionResults,
    };
  }

  private calculateNegativePoints(dimensionId: string, context: ScoringRuleContext): number {
    const dim = this.config.dimensions.find(d => d.id === dimensionId);
    if (!dim) return 0;

    const findings = context.findings.filter(f => f.category === dimensionId);
    let totalPenalty = 0;

    for (const finding of findings) {
      const multiplier = dim.penalties.severityMultipliers[finding.severity] ?? 1;
      totalPenalty += dim.penalties.perIssuePenalty * multiplier;
    }

    return Math.min(totalPenalty, dim.penalties.maxPenalty);
  }

  private calculatePositivePoints(dimensionId: string, context: ScoringRuleContext): number {
    const dim = this.config.dimensions.find(d => d.id === dimensionId);
    if (!dim) return 0;

    let totalPoints = 0;
    for (const rule of dim.positiveRules) {
      if (rule.condition(context)) {
        totalPoints += rule.points;
      }
    }
    return totalPoints;
  }

  private toGrade(score: number): ScoreGrade {
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 60) return 'C';
    return 'D';
  }

  getConfig(): ScoringConfig {
    return this.config;
  }

  updateConfig(config: ScoringConfig): void {
    this.config = config;
  }
}
