import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getScore, getDomainScore } from '../services/engineApi';
import {
  domainScoreView,
  pickDomainScore,
  type DomainScoreView,
  type ScoreDimension,
} from '../pages/domain-score-logic';

/**
 * 分类页「本域评分」卡。
 *
 * ⚠️ 只读不算：分数由 @zh/scoring 统一产出，本组件绝不二次计算，
 * 避免与总分口径分叉（批 6 教训）。两个数据源（pickDomainScore 选源）：
 * - 实时（live=true）：引擎在检查落盘时写进按域快照的评分 —— 跑完当场出分；
 * - 汇总：报告中心「汇总生成报告」落库的 HealthScoreData。
 * live 快照缺失或为旧格式时自动回退汇总数据。
 *
 * 展示语义（与批 5 not-run 修复同源）：
 * - 尚无任何评分 → 「暂无评分」；live 页提示跑完一次检查即出分；
 * - 本域从未运行（not-run） → 「未检测」，中性灰，不按 0 分上色；
 * - 已评分 → 分数 + 等级色；数据超过 24h 附陈旧提示（SCORE_FRESH_MS 同口径）。
 *
 * @param refreshKey 变化时重新拉取（如检查完成后的 report 对象）——
 *   组件本身不订阅流水线事件，靠调用方在跑完时换 key 刷新。
 */
export function DomainScoreCard({
  projectPath,
  dimension,
  live = false,
  refreshKey,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  /** 是否优先读按域快照实时评分（当前仅巡检页：inspect → quality） */
  live?: boolean;
  /** 变化时重新拉取评分 */
  refreshKey?: unknown;
}) {
  const t = useT();
  const [view, setView] = useState<DomainScoreView | null>(null);

  useEffect(() => {
    let alive = true;
    setView(null);
    (async () => {
      const [liveScore, summary] = await Promise.all([
        live ? getDomainScore(projectPath, 'inspect') : Promise.resolve(null),
        getScore(projectPath),
      ]);
      if (!alive) return;
      const picked = pickDomainScore(liveScore, summary, dimension);
      setView(domainScoreView(picked.dim, picked.generatedAt, Date.now(), t, picked.previousScore));
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, dimension, live, refreshKey]);

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
      {typeof view.previousScore === 'number' && (
        <span
          className="text-xs shrink-0"
          style={{
            color:
              Number(view.scoreText) > view.previousScore
                ? 'rgb(var(--zh-success))'
                : Number(view.scoreText) < view.previousScore
                  ? 'rgb(var(--zh-danger))'
                  : 'rgb(var(--zh-muted))',
          }}
          data-testid={`domain-score-prev-${dimension}`}
        >
          {t('page.domainScore.scoreDelta', {
            prev: view.previousScore,
            now: view.scoreText,
          })}
        </span>
      )}
      <div className="text-xs text-zh-muted ml-auto text-right">
        {view.kind === 'no-data' &&
          (live ? t('page.domainScore.noDataHintLive') : t('page.domainScore.noDataHint'))}
        {view.kind === 'not-run' && t('page.domainScore.notRunHint')}
        {view.kind === 'stale' &&
          t('page.reports.dataStale', { hours: view.ageHours })}
      </div>
    </div>
  );
}
