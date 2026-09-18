import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getScore } from '../services/engineApi';
import { domainScoreView, findDimension, type DomainScoreView, type ScoreDimension } from '../pages/domain-score-logic';

/**
 * 分类页「本域评分」卡 —— 展示报告中心最近一次汇总里本分类对应的维度分。
 *
 * ⚠️ 只读不算：分数由 @zh/scoring 在「汇总生成报告」时统一产出（各域扣分制、
 * 权重画像可调），本组件绝不二次计算，避免与总分口径分叉（批 6 教训）。
 *
 * 展示语义（与批 5 not-run 修复同源）：
 * - 尚未汇总过 → 「暂无评分」，提示去报告中心汇总；
 * - 本域从未运行（not-run） → 「未检测」，中性灰，不按 0 分上色；
 * - 已评分 → 分数 + 等级色；数据超过 24h 附陈旧提示（SCORE_FRESH_MS 同口径）。
 */
export function DomainScoreCard({
  projectPath,
  dimension,
}: {
  projectPath: string;
  dimension: ScoreDimension;
}) {
  const t = useT();
  const [view, setView] = useState<DomainScoreView | null>(null);

  useEffect(() => {
    let alive = true;
    setView(null);
    (async () => {
      const data = await getScore(projectPath);
      if (!alive) return;
      setView(domainScoreView(findDimension(data, dimension), data?.timestamp));
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, dimension]);

  if (!view) return null; // 加载中不闪占位

  return (
    <div
      className="flex items-center gap-4 mb-6 px-5 py-3.5 rounded-xl border border-zh-line bg-white"
      data-testid={`domain-score-${dimension}`}
    >
      <div className="text-xs text-zh-muted shrink-0">{t('page.domainScore.title')}</div>
      <div className="text-2xl font-bold leading-none" style={{ color: view.color }}>
        {view.scoreText}
      </div>
      <span
        className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
        style={{ color: view.color, background: `color-mix(in srgb, ${view.color} 10%, transparent)` }}
      >
        {view.label}
      </span>
      <div className="text-xs text-zh-muted ml-auto text-right">
        {view.kind === 'no-data' && t('page.domainScore.noDataHint')}
        {view.kind === 'not-run' && t('page.domainScore.notRunHint')}
        {view.kind === 'stale' &&
          t('page.reports.dataStale', { hours: view.ageHours })}
      </div>
    </div>
  );
}
