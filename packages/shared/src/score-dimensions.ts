export type HealthScoreDimension =
  | 'quality'
  | 'gate'
  | 'security'
  | 'dependencies'
  | 'techdebt'
  | 'refactor'
  | 'performance'
  | 'sentinel'
  | 'garbage'
  | 'backup';

export const HEALTH_SCORE_DIMENSIONS: readonly HealthScoreDimension[] = [
  'quality',
  'gate',
  'security',
  'dependencies',
  'techdebt',
  'refactor',
  'performance',
  'sentinel',
  'garbage',
  'backup',
] as const;

export type ScoreDimension = HealthScoreDimension;
export const SCORE_DIMENSIONS = HEALTH_SCORE_DIMENSIONS;

export function isScoreDimension(value: unknown): value is ScoreDimension {
  return typeof value === 'string' && SCORE_DIMENSIONS.includes(value as any);
}
