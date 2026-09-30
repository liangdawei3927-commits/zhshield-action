import { useEffect, useState } from 'react';
import { getScore, getDomainScore } from '../../services/engineApi';
import {
  domainScoreView,
  pickDomainScore,
  type DomainScoreView,
  type ScoreDimension,
} from '../../pages/domain-score-logic';
import { HealthRing } from './HealthRing';

/**
 * 分类页主页空态中央的 270° 健康评分环。
 *
 * 数据流与 DomainScoreCard 完全同源（只读不算）：实时按域快照优先，
 * 回退报告中心汇总，分数由 @zh/scoring 统一产出，本组件绝不二次计算。
 * 仅渲染环本身（无标题/徽章/对比文案）；无分数时 HealthRing 自动灰环 '--'。
 */
export function DomainScoreRing({
  projectPath,
  dimension,
  size = 220,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  size?: number;
}) {
  const [view, setView] = useState<DomainScoreView | null>(null);

  useEffect(() => {
    let alive = true;
    setView(null);
    (async () => {
      const [liveScore, summary] = await Promise.all([
        getDomainScore(projectPath, dimension),
        getScore(projectPath),
      ]);
      if (!alive) return;
      const picked = pickDomainScore(liveScore, summary, dimension);
      setView(domainScoreView({ dim: picked.dim, generatedAt: picked.generatedAt }));
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, dimension]);

  if (!view) return null; // 加载中不闪占位

  const hasScore = view.kind === 'scored' || view.kind === 'stale';
  return <HealthRing score={hasScore ? Number(view.scoreText) : null} size={size} />;
}