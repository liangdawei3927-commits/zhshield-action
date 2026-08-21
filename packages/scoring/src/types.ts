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
