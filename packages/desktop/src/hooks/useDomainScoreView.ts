import { useEffect, useState } from 'react';
import type { ScoreDimension } from '@zh/shared';
import { getScore, getDomainScore } from '../services/engineApi';
import {
  domainScoreView,
  pickDomainScore,
  type DomainScoreView,
} from '../pages/domain-score-logic';

export interface UseDomainScoreViewOptions {
  projectPath: string;
  dimension: ScoreDimension;
  live?: boolean;
  refreshKey?: unknown;
}

export function useDomainScoreView({
  projectPath,
  dimension,
  live = false,
  refreshKey,
}: UseDomainScoreViewOptions): DomainScoreView | null {
  const [view, setView] = useState<DomainScoreView | null>(null);

  useEffect(() => {
    let alive = true;
    setView(null);
    (async () => {
      const [liveScore, summary] = await Promise.all([
        live ? getDomainScore(projectPath, dimension) : Promise.resolve(null),
        getScore(projectPath),
      ]);
      if (!alive) return;
      const picked = pickDomainScore(liveScore, summary, dimension);
      setView(domainScoreView(picked));
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, dimension, live, refreshKey]);

  return view;
}
