export type ScoreGrade = 'A' | 'B' | 'C' | 'D';
export type ScoreTrend = 'improving' | 'stable' | 'declining';

export interface DimensionScore {
  name: string;
  weight: number;
  score: number;
  issues: number;
}

export interface HealthScore {
  projectId: string;
  timestamp: Date;
  overall: number;
  grade: ScoreGrade;
  dimensions: DimensionScore[];
  trend: ScoreTrend;
}

export interface DimensionTrend {
  name: string;
  current: number;
  trend: ScoreTrend;
  slope: number;
}

export interface TrendReport {
  projectId: string;
  current: HealthScore | null;
  overallTrend: ScoreTrend;
  velocity: number;
  acceleration: number;
  volatility: number;
  projectedScore: number | null;
  dimensionTrends: DimensionTrend[];
  insights: string[];
  streak: { direction: ScoreTrend; count: number };
}

export interface ScoringRuleContext {
  findings: Array<{ severity: string; category: string }>;
  metrics: {
    dependencyCount: number;
    testCoverage?: number;
    circularDependencies: number;
    totalFiles: number;
    documentationCoverage?: number;
  };
}

export interface PositiveRule {
  id: string;
  name: string;
  description: string;
  dimension: string;
  points: number;
  condition: (ctx: ScoringRuleContext) => boolean;
}

export interface DimensionDefinition {
  id: string;
  name: string;
  weight: number;
  description: string;
  penalties: {
    dimension: string;
    maxPenalty: number;
    perIssuePenalty: number;
    severityMultipliers: Record<string, number>;
  };
  positiveRules: PositiveRule[];
}

export interface ScoringConfig {
  version: string;
  lastUpdated: Date;
  dimensions: DimensionDefinition[];
}
