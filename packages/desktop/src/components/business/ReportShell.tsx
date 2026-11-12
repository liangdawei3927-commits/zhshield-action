import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { ScoreDimension } from '@zh/shared';
import { DomainScoreCard, type ScoreCardCoverage } from '../DomainScoreCard';
import { DomainHistoryPanel } from './DomainHistoryPanel';
import { ResultCard } from '../../components/ui/ResultCard';

/** 统计卡：点击后展开 detail 明细（无 detail 的卡不响应点击） */
export interface ReportStatCard {
  key: string;
  label: string;
  /** 卡上数字 */
  value: number | string;
  /** 数字颜色（缺省 text-zh-ink） */
  color?: string;
  detail?: {
    /** 该卡明细数据（点击卡片后展示的子集） */
    items: unknown[];
    /** 渲染该卡明细（页面传入，内部自带复制/交互） */
    render: (items: unknown[]) => ReactNode;
    /** 展开区顶部提示文案（可选） */
    hint?: string;
  };
}

export interface ReportShellProps {
  projectPath: string;
  dimension: ScoreDimension;
  /** 传给 DomainScoreCard */
  refreshKey?: unknown;
  /** 规则级覆盖（R6）；传给缺省评分卡，run < total 时降级为「已检测部分均分」 */
  coverage?: ScoreCardCoverage;
  /** 顶行左侧分类功能图标（调用方传入 Bounce+svg 块） */
  icon: ReactNode;
  /** 顶行标题（如 t('nav.sentinel')） */
  title: string;
  /** 缺省自动渲染 DomainScoreCard inline；传了则用自定义 */
  score?: ReactNode;
  /** 顶行右侧原有按钮（重扫/刷新等），最右 */
  action: ReactNode;
  /** 返回本分类「主页」（空态）回调 */
  onBackHome: () => void;
  /** 返回主页按钮 title/aria-label（默认 t('page.reportShell.backHome')） */
  backHomeTitle?: string;
  /** 统计卡片行（总/通过/问题…），可选 */
  stats?: ReportStatCard[];
  /** 统计卡行下方明细区内容 */
  children?: ReactNode;
  /**
   * 该页对应的域键（inspect/refactor/deps/…）。
   * 传了即在明细区下方追加「历史记录」面板（每次检查一条、带涨跌）；
   * 不传或该域无历史 → 不渲染，不影响任何既有布局。
   */
  historyDomain?: string;
  /** 外壳 className 变体 */
  containerClassName?: string;
  /**
   * 顶行是否显示「检查时间」小字（默认 true）。
   * 安全页已在分类标签行右侧显示，传 false 避免同一时间出现两次。
   */
  showScannedAt?: boolean;
}

/** 顶行左上角返回主页按钮 */
function ReportBackHomeButton({ onBackHome, label }: { onBackHome: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBackHome}
      title={label}
      aria-label={label}
      data-testid="report-back-home"
      className="absolute top-2 left-2 z-10 w-9 h-9 rounded-full flex items-center justify-center border border-zh-line bg-white text-zh-muted hover:text-brand-600 hover:border-brand-600 transition-colors"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
  );
}

/** 顶行：icon + 标题块（标题 + 评分）+ 检查时间 + ml-auto 操作按钮 */
function ReportHeaderRow({
  icon,
  title,
  score,
  action,
  scannedAtLabel,
}: {
  icon: ReactNode;
  title: string;
  score: ReactNode;
  action: ReactNode;
  /** 「检查时间 …」小字；无有效时间时不渲染 */
  scannedAtLabel?: string | null;
}) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-zh-ink">{title}</h1>
        <div className="mt-2">{score}</div>
      </div>
      <div className="ml-auto flex items-center gap-4 shrink-0">
        {scannedAtLabel ? (
          <span className="text-[11px] whitespace-nowrap text-zh-muted">{scannedAtLabel}</span>
        ) : null}
        {action}
      </div>
    </div>
  );
}

/**
 * 各域报告的时间字段不统一：`metadata.timestamp`（巡检/门禁/安全/性能）、
 * `timestamp`（垃圾/重构/备份）、`generatedAt`（依赖/技术债）、`checkedAt`（CVE）。
 * 取到有效日期才算数，拿不准就不显示，避免把“无效时间”画成检查时间。
 */
function pickScannedAt(value: unknown): Date | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    metadata?: { timestamp?: unknown };
    timestamp?: unknown;
    generatedAt?: unknown;
    checkedAt?: unknown;
  };
  const candidate =
    record.metadata?.timestamp ?? record.timestamp ?? record.generatedAt ?? record.checkedAt;
  const date =
    candidate instanceof Date
      ? candidate
      : typeof candidate === 'string'
        ? new Date(candidate)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** 哨兵传的是事件数组：取最近一条的时间；其他域直接读报告对象 */
function resolveScannedAt(refreshKey: unknown): Date | null {
  if (Array.isArray(refreshKey)) {
    let latest: Date | null = null;
    for (const item of refreshKey) {
      const date = pickScannedAt(item);
      if (date && (!latest || date.getTime() > latest.getTime())) latest = date;
    }
    return latest;
  }
  return pickScannedAt(refreshKey);
}

/** 统计卡行：点击后展开 detail 明细（无 detail 的卡不响应点击） */
function ReportStatsRow({
  stats,
  expandedKey,
  onToggle,
}: {
  stats?: ReportStatCard[];
  expandedKey: string | null;
  onToggle: (next: ReportStatCard | null) => void;
}) {
  if (!stats || stats.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-4 mb-6">
      {stats.map((s) => {
        const clickable = Boolean(s.detail);
        const expanded = expandedKey === s.key;
        // 只有真能点的卡才给手型与 hover 高亮：无 detail 的卡渲染成 div，
        // 若仍带着 cursor-pointer + hover 边框，用户点下去毫无反应 = 交互骗人。
        const interactivity = clickable
          ? 'text-left cursor-pointer hover:border-brand-600 hover:shadow-md transition-all'
          : '';
        return (
          <ResultCard
            key={s.key}
            as={clickable ? 'button' : 'div'}
            variant="stats"
            className={`flex-1 min-w-[160px] ${interactivity}`.trim()}
            data-stat-key={s.key}
            data-stat-clickable={clickable ? 'true' : 'false'}
            onClick={clickable ? () => onToggle(expanded ? null : s) : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-zh-muted">{s.label}</div>
              {clickable && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`text-zh-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              )}
            </div>
            <div className="text-2xl font-bold mt-1" style={{ color: s.color }}>
              {s.value}
            </div>
          </ResultCard>
        );
      })}
    </div>
  );
}

/** 展开区（手风琴，一次最多一张） */
function ReportStatDetail({ stat }: { stat: ReportStatCard | null }) {
  if (!stat?.detail) return null;
  return (
    <div className="mb-6" data-testid={`report-stat-detail-${stat.key}`}>
      {stat.detail.hint && (
        <div className="mb-3 border-l-2 border-brand-600 pl-3">
          <p className="text-sm leading-5 text-zh-ink-2">{stat.detail.hint}</p>
        </div>
      )}
      {stat.detail.render(stat.detail.items)}
    </div>
  );
}

/**
 * 副页公共骨架：10 个分类检查页「检查结果状态」的统一布局。
 * 顶行（icon + 标题 + 评分 + 操作按钮 + 返回主页）+ 统计卡行（可点击展开明细手风琴）+ 明细区。
 */
export function ReportShell({
  projectPath,
  dimension,
  refreshKey,
  coverage,
  icon,
  title,
  score,
  action,
  onBackHome,
  backHomeTitle,
  stats,
  children,
  historyDomain,
  containerClassName = 'h-full w-full bg-zh-bg overflow-auto',
  showScannedAt = true,
}: ReportShellProps) {
  const t = useT();
  // 检查时间放在顶行右侧、操作按钮左边：所有分类详情页同一位置
  const scannedAt = showScannedAt ? resolveScannedAt(refreshKey) : null;
  const scannedAtLabel = scannedAt
    ? t('page.reportShell.scannedAt', {
        defaultValue: '检查时间 {{time}}',
        time: scannedAt.toLocaleString(),
      })
    : null;
  const [expandedStat, setExpandedStat] = useState<ReportStatCard | null>(null);
  // 分类为 0 时卡片会消失：已展开的那张必须同步清掉，否则会留下空明细面板。
  const visibleStat =
    expandedStat && stats?.some((s) => s.key === expandedStat.key) ? expandedStat : null;
  useEffect(() => {
    if (expandedStat && !stats?.some((s) => s.key === expandedStat.key)) {
      setExpandedStat(null);
    }
  }, [expandedStat, stats]);
  const backHomeLabel = backHomeTitle ?? t('page.reportShell.backHome');

  return (
    <div className={containerClassName}>
      <div className="w-full px-8 py-10 relative">
        <ReportBackHomeButton onBackHome={onBackHome} label={backHomeLabel} />
        <ReportHeaderRow
          icon={icon}
          title={title}
          score={
            score ?? (
              <DomainScoreCard
                projectPath={projectPath}
                dimension={dimension}
                live
                refreshKey={refreshKey}
                coverage={coverage}
                inline
              />
            )
          }
          action={action}
          scannedAtLabel={scannedAtLabel}
        />
        <ReportStatsRow
          stats={stats}
          expandedKey={visibleStat?.key ?? null}
          onToggle={(next) => setExpandedStat(next)}
        />
        <ReportStatDetail stat={visibleStat} />
        {children}
        <DomainHistoryPanel projectPath={projectPath} domain={historyDomain} />
      </div>
    </div>
  );
}
