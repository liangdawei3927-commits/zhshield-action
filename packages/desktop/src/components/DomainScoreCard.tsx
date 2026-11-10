import { useT } from '../i18n';
import type { DomainScoreView } from '../pages/domain-score-logic';
import { dimensionSources } from '../pages/domain-score-logic';
import type { ScoreDimension } from '@zh/shared';

/** 评分数据拉取：live 快照优先、汇总回退，构建展示视图（refreshKey 变化时重新拉取） */
import { useDomainScoreView } from '../hooks/useDomainScoreView';

/**
 * 本次检查的规则级覆盖（R6 Phase 1：由调用方从报告的 checks 直接算出）。
 *
 * Phase 2 起改由评分链路 `DimensionScore.coverage` 下发；字段保持同形，
 * 避免「渲染层一套、评分层另一套」在同一个分数上打架。
 */
export interface ScoreCardCoverage {
  /** 已求值的规则数（含「不适用」：规则跑了、只是本项目没有可检对象） */
  run: number;
  /** 计划评估的规则数 */
  total: number;
}

export function DomainScoreCard({
  projectPath,
  dimension,
  live = false,
  refreshKey,
  inline = false,
  coverage,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  /** 是否优先读按域快照实时评分：读当前 dimension 对应域的实时分（仅巡检页 quality 走落盘快照快路径，其余按域组合读取） */
  live?: boolean;
  /** 变化时重新拉取评分 */
  refreshKey?: unknown;
  /** inline 模式：无边框/无下边距，供副页顶行（状态行）嵌入，与标题按钮同排 */
  inline?: boolean;
  /**
   * 规则级覆盖：传了且 run < total 时，分数语义降级为「已检测部分均分」，
   * 不显示等级（R6）。缺省 = 本次没有规则账（旧快照/其他域），保持既有展示。
   */
  coverage?: ScoreCardCoverage;
}) {
  const t = useT();
  const view = useDomainScoreView({ projectPath, dimension, live, refreshKey });

  if (!view) return null; // 加载中不闪占位
  if (inline)
    return <InlineDomainScore view={view} dimension={dimension} t={t} coverage={coverage} />;
  return (
    <FullDomainScore view={view} dimension={dimension} live={live} t={t} coverage={coverage} />
  );
}

function InlineDomainScore({
  view,
  dimension,
  t,
  coverage,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  t: ReturnType<typeof useT>;
  coverage?: ScoreCardCoverage;
}) {
  return (
    <div className="flex items-center gap-3 shrink-0" data-testid={`domain-score-${dimension}`}>
      <DomainScoreBadges view={view} dimension={dimension} t={t} coverage={coverage} />
    </div>
  );
}

/** 完整评分条：标题 + 分数 + 等级徽章 + 上次对比 + 陈旧/无数据提示 */
function FullDomainScore({
  view,
  dimension,
  live,
  t,
  coverage,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  live: boolean;
  t: ReturnType<typeof useT>;
  coverage?: ScoreCardCoverage;
}) {
  return (
    <div
      className="flex items-center gap-4 mb-6 px-5 py-3.5 rounded-xl border border-zh-line bg-white"
      data-testid={`domain-score-${dimension}`}
    >
      <DomainScoreBadges view={view} dimension={dimension} t={t} showSources coverage={coverage} />
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
  showSources = false,
  coverage,
}: {
  view: DomainScoreView;
  dimension: ScoreDimension;
  t: ReturnType<typeof useT>;
  /** P1-6：完整模式显示"数据来源"标注（inline 模式不显示以免挤占） */
  showSources?: boolean;
  /** R6：规则级覆盖；run < total 时分数语义降级为「已检测部分均分」，不显示等级 */
  coverage?: ScoreCardCoverage;
}) {
  // R6 Phase 1：只要本次有规则没跑，分数就只能叫「已检测部分均分」。
  // 98 与「12/20 通过」并存时，98 的真实语义是「查过的 13 项里几乎没问题」，
  // 不是「项目健康 98 分」——等级与「优秀」必须让位给覆盖事实（契约 C4）。
  const hasScore = view.kind === 'scored' || view.kind === 'stale';
  const partial = hasScore && coverage !== undefined && coverage.run < coverage.total;
  const displayColor = partial ? 'rgb(var(--zh-warning))' : view.color;
  const displayLabel = partial ? t('page.domainScore.partialLabel') : view.label;
  return (
    <>
      <div className="text-xs text-zh-muted shrink-0">{t('page.domainScore.title')}</div>
      <div className="text-2xl font-bold leading-none" style={{ color: displayColor }}>
        {view.scoreText}
      </div>
      <span
        className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
        style={{
          color: displayColor,
          background: `color-mix(in srgb, ${displayColor} 10%, transparent)`,
        }}
      >
        {displayLabel}
      </span>
      {coverage && hasScore && (
        <DomainCoverageBadge
          dimension={dimension}
          coverage={coverage}
          partial={partial}
          t={t}
        />
      )}
      {showSources && view.kind !== 'no-data' && (
        <span
          className="text-[11px] text-zh-muted shrink-0"
          data-testid={`domain-score-sources-${dimension}`}
        >
          {t('page.domainScore.sources', {
            sources: dimensionSources(dimension).join(' + '),
          })}
        </span>
      )}
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

/** R6 覆盖徽章：partial 时同时给出缺口数量，与等级抑制同源（全仓唯一一处文案拼装） */
function DomainCoverageBadge({
  dimension,
  coverage,
  partial,
  t,
}: {
  dimension: ScoreDimension;
  coverage: ScoreCardCoverage;
  partial: boolean;
  t: ReturnType<typeof useT>;
}) {
  return (
    <span
      className="text-[11px] shrink-0"
      data-testid={`domain-score-coverage-${dimension}`}
      style={{ color: partial ? 'rgb(var(--zh-warning))' : 'rgb(var(--zh-muted))' }}
    >
      {t('page.domainScore.coverageBadge', {
        run: coverage.run,
        total: coverage.total,
      })}
      {partial
        ? ` · ${t('page.domainScore.coverageGap', { count: coverage.total - coverage.run })}`
        : ''}
    </span>
  );
}

/** inline 模式评分条：无边框/无下边距，供副页顶行（状态行）嵌入，与标题按钮同排 */
