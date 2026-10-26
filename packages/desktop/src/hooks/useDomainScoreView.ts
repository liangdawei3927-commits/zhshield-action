import { useEffect, useState } from 'react';
import type { ScoreDimension } from '@zh/shared';
import { getScore, getDomainScore } from '../services/engineApi';
import { useDimensionSettledTick } from '../task-store';
import {
  domainScoreView,
  pickDomainScore,
  type DomainScoreView,
} from '../pages/domain-score-logic';

/** 域评分视图 Hook 的配置选项 */
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
  // P0-1：该维度对应的扫描任务落定（完成/失败/取消）时 tick+1 → 自动重拉分数。
  // 修复「后台任务跑完，页面分数停在 --，必须切 tab 才刷新」。
  const settledTick = useDimensionSettledTick(dimension, projectPath);

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
  }, [projectPath, dimension, live, refreshKey, settledTick]);

  return view;
}
