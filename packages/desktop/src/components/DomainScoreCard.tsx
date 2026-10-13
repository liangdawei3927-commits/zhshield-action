import { useT } from '../i18n';
import type { DomainScoreView } from '../pages/domain-score-logic';
import type { ScoreDimension } from '@zh/shared';

/** 评分数据拉取：live 快照优先、汇总回退，构建展示视图（refreshKey 变化时重新拉取） */
import { useDomainScoreView } from '../hooks/useDomainScoreView';

export function DomainScoreCard({
  projectPath,
  dimension,
  live = false,
  refreshKey,
  inline = false,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  /** 是否优先读按域快照实时评分：读当前 dimension 对应域的实时分（仅巡检页 quality 走落盘快照快路径，其余按域组合读取） */
  live?: boolean;
  /** 变化时重新拉取评分 */
  refreshKey?: unknown;
  /** inline 模式：无边框/无下边距，供副页顶行（状态行）嵌入，与标题按钮同排 */
  inline?: boolean;
}) {
  const t = useT();
  const view = useDomainScoreView({ projectPath, dimension, live, refreshKey });

  if (!view) return null; // 加载中不闪占位
  if (inline) return <InlineDomainScore view={view} dimension={dimension} t={t} />;
  return <FullDomainScore view={view} dimension={dimension} live={live} t={t} />;
}

function InlineDomainScore({
  view,
  dimension,
  t,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div
      className="flex items-center gap-3 shrink-0"
      data-testid={`domain-score-${dimension}`}
    >
      <DomainScoreBadges view={view} dimension={dimension} t={t} />
    </div>
  );
}

/** 完整评分条：标题 + 分数 + 等级徽章 + 上次对比 + 陈旧/无数据提示 */
function FullDomainScore({
  view,
  dimension,
  live,
  t,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  live: boolean;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div
      className="flex items-center gap-4 mb-6 px-5 py-3.5 rounded-xl border border-zh-line bg-white"
      data-testid={`domain-score-${dimension}`}
    >
      <DomainScoreBadges view={view} dimension={dimension} t={t} />
      <div className="text-xs text-zh-muted ml-auto text-right">
        {view.kind === 'no-data' &&
          (live ? t('page.domainScore.noDataHintLive') : t('page.domainScore.noDataHint'))}
        {view.kind === 'not-run' && t('page.domainScore.notRunHint')}
        {view.kind === 'stale' && t('page.reports.dataStale', { hours: view.ageHours })}
      </div>
    </div>
  );
}


function DomainScoreBadges({
  view,
  dimension,
  t,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  t: ReturnType<typeof useT>;
}) {
  return (
    <>
      <div className="text-xs text-zh-muted shrink-0">{t('page.domainScore.title')}</div>
      <div className="text-2xl font-bold leading-none" style={{ color: view.color }}>
        {view.scoreText}
      </div>
      <span
        className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
        style={{
          color: view.color,
          background: `color-mix(in srgb, ${view.color} 10%, transparent)`,
        }}
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
    </>
  );
}

/** inline 模式评分条：无边框/无下边距，供副页顶行（状态行）嵌入，与标题按钮同排 */
