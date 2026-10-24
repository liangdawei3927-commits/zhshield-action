import { useT } from '../i18n';
import { useNavigation } from '../contexts/NavigationContext';
import { ResultCard } from '../components/ui/ResultCard';
import { getScoreColor, getScoreLabel, scoreFreshness } from './reports-logic';
import type { ScoreFreshness } from './reports-logic';
import {
  categoryScoreCards,
  type CategoryScoreCardView,
  type DimensionEntry,
} from './category-score-logic';

/**
 * 报告中心「评分总览」一行：首格总分，后接十张分类卡。
 *
 * 为什么合并成一行：总分与十个分**必须同屏可比** —— 分成上下两块时，看总分要抬头、
 * 看域分要低头，还得自己比对「哪个域拖了总分」。一行排开后「总分 89.5 旁边摆着
 * 一堆 90+ 和几个 60-」本身就是结论。
 *
 * 三条约束：
 * 1. **总分卡不可点** —— 它不属于任何分类，点了没有落点；做成 button 却无效果是
 *    典型的假交互。分类卡才是导航入口。
 * 2. **一行到底**：11 列均分（总分同样只占 1 格）。900px 最小窗宽下每格约 68px，
 *    主次靠「总分」标签 + 更大字号 + 面板底色区分，而不是靠给总分更多宽度 ——
 *    挤出来的那点宽度不够用，反而把十张分类卡压到放不下 4 字名。
 * 3. **标题区只留标题**：趋势图与常驻「数据时间」不放在卡片上方 —— 总分卡与分类卡
 *    已经把分数摆在眼前，上面再挂一行「89.5 ↑0.5 / 数据时间 …」是重复信息且抢视线。
 *    但**陈旧不静默**：超过阈值时改由下方提示条报出（见 ScoreNotices），
 *    常驻文案可以删，「把一周前的分当当前状态」这个错误不能重新出现。
 *
 * 点击行为：只做页面切换（`navigate(navId)`），**不发起任何检查** ——
 * 与「报告中心只读汇总各域最新结果、触发权归各域自己」的产品约定一致。
 * 没有 NavigationProvider（组件独立渲染）时分类卡降级为不可点击，不报错、不静默跳默认页。
 */

/** 总分卡入参 */
export interface OverallScoreInput {
  score: number;
  /** 参与加权的维度数 / 总维度数（未检测维度不计入加权） */
  partial: { run: number; total: number };
  /** 红线封顶：存在 critical 事实时总评被压制的原因 */
  redLine?: {
    capped: boolean;
    cap: number;
    reasons: Array<{ kind: string; count: number }>;
  };
}

export function ScoreOverviewRow({
  dimensions,
  generatedAt,
  overall,
}: {
  dimensions: readonly DimensionEntry[];
  /** 汇总时间戳：用于判定分数是否陈旧（同类卡片同口径） */
  generatedAt: string;
  overall: OverallScoreInput;
}) {
  const t = useT();
  const navigation = useNavigation();
  const cards = categoryScoreCards({ dimensions, generatedAt, tr: t });
  const freshness = scoreFreshness(generatedAt);

  return (
    <section className="mb-6" data-testid="score-overview-row">
      <h2 className="text-sm font-semibold text-zh-ink-2 mb-2">
        {t('page.reports.categoryScore.title')}
      </h2>

      <div className="grid grid-cols-11 gap-2">
        <OverallScoreTile score={overall.score} label={t('page.reports.categoryScore.overall')} />
        {cards.map((card, index) => (
          <CategoryScoreTile
            key={card.navId}
            card={card}
            onSelect={navigation?.navigate}
            openLabel={t('page.reports.categoryScore.open', { name: card.title })}
            // 组间留缝：与导航栏同一处分段（按需检查 ‖ 常驻守护），不留缝则两类分又混成一片
            startsGroup={index > 0 && card.group !== cards[index - 1]!.group}
          />
        ))}
      </div>

      <ScoreNotices overall={overall} freshness={freshness} />
    </section>
  );
}

/** 总分卡：与分类卡同宽，靠面板底色 + 更大字号区分主次；不可点击 */
function OverallScoreTile({ score, label }: { score: number; label: string }) {
  const color = getScoreColor(score);
  return (
    <ResultCard
      variant="tile"
      data-testid="overall-score-tile"
      data-kind="overall"
      style={{ background: 'rgb(var(--zh-bg-secondary))' }}
      className="flex flex-col items-center justify-center gap-1 min-w-0 text-center"
    >
      <span className="w-full text-[11px] leading-tight text-zh-muted truncate">{label}</span>
      <span className="text-2xl font-bold leading-none tabular-nums" style={{ color }}>
        {score}
      </span>
      <span
        className="max-w-full text-[10px] px-1.5 py-0.5 rounded-full font-medium truncate"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        {getScoreLabel(score)}
      </span>
    </ResultCard>
  );
}

/**
 * 提示条：陈旧、覆盖范围、红线封顶。
 *
 * 这三条决定「这个总分能不能信」——一周前的 92 分不是当前状态，只跑了 2 个域的
 * 92 分不是全量体检结论，被红线压到 60 的分也不是真的只有 60。
 * 卡片上方精简排版时最容易顺手删掉，故单独成组件，并由测试锁定「有则显示、无则不显示」。
 */
function ScoreNotices({
  overall,
  freshness,
}: {
  overall: OverallScoreInput;
  freshness: ScoreFreshness;
}) {
  const t = useT();
  const notices: Array<{ text: string; color: string; testId: string }> = [];
  if (freshness.stale) {
    notices.push({
      text: t('page.reports.dataStale', { hours: freshness.ageHours }),
      color: 'rgb(var(--zh-warning))',
      testId: 'stale-notice',
    });
  }
  if (overall.partial.run < overall.partial.total) {
    notices.push({
      text: t('page.reports.partialDimensions', {
        run: overall.partial.run,
        total: overall.partial.total,
      }),
      color: 'rgb(var(--zh-warning))',
      testId: 'partial-notice',
    });
  }
  if (overall.redLine?.capped) {
    const reasons = overall.redLine.reasons
      .map((r) => t(`page.reports.redLine.${r.kind}`, { count: r.count }))
      .join(' · ');
    notices.push({
      text: `${t('page.reports.redLine.capNotice', { cap: overall.redLine.cap })}${reasons}`,
      color: 'rgb(var(--zh-danger))',
      testId: 'redline-notice',
    });
  }
  if (notices.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {notices.map((n) => (
        <span key={n.testId} className="text-xs" style={{ color: n.color }} data-testid={n.testId}>
          {n.text}
        </span>
      ))}
    </div>
  );
}

function CategoryScoreTile({
  card,
  onSelect,
  openLabel,
  startsGroup,
}: {
  card: CategoryScoreCardView;
  onSelect?: (page: string) => void;
  openLabel: string;
  /** true = 本卡是另一个分组的第一张，左侧加缝与上一组分开 */
  startsGroup?: boolean;
}) {
  const { view } = card;
  // 未检测 / 无数据：整卡降透明度，避免「灰 —」被当成 0 分看待
  const dimmed = view.kind === 'no-data' || view.kind === 'not-run';
  return (
    <ResultCard
      variant="tile"
      as="button"
      type="button"
      onClick={onSelect ? () => onSelect(card.navId) : undefined}
      disabled={!onSelect}
      title={card.hint}
      aria-label={onSelect ? openLabel : card.title}
      data-testid={`category-score-${card.navId}`}
      data-nav-target={card.navId}
      data-dimension={card.dimension}
      data-group={card.group}
      data-starts-group={startsGroup ? 'true' : undefined}
      data-kind={view.kind}
      className={`flex flex-col items-center justify-center gap-1 min-w-0 text-center transition-shadow${startsGroup ? ' ml-2' : ''}${dimmed ? ' opacity-60' : ''}${onSelect ? ' cursor-pointer hover:shadow-md' : ''}`}
    >
      <span className="w-full text-[11px] leading-tight text-zh-muted truncate">{card.title}</span>
      <span className="text-xl font-bold leading-none tabular-nums" style={{ color: view.color }}>
        {view.scoreText}
      </span>
      <span
        className="max-w-full text-[10px] px-1.5 py-0.5 rounded-full font-medium truncate"
        style={{
          color: view.color,
          background: `color-mix(in srgb, ${view.color} 12%, transparent)`,
        }}
      >
        {view.label}
      </span>
    </ResultCard>
  );
}
