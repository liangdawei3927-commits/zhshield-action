import type { ScoreDimension } from '@zh/shared';
import { HealthRing } from './HealthRing';
import { useDomainScoreView } from '../../hooks/useDomainScoreView';

export function DomainScoreRing({
  projectPath,
  dimension,
  size = 260,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  size?: number;
}) {
  const view = useDomainScoreView({ projectPath, dimension, live: true });

  if (!view) return null;
  const hasScore = view.kind === 'scored' || view.kind === 'stale';
  return <HealthRing score={hasScore ? Number(view.scoreText) : null} size={size} />;
}
