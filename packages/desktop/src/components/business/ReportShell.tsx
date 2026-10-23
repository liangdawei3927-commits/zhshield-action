import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { ScoreDimension } from '@zh/shared';
import { DomainScoreCard } from '../DomainScoreCard';
import { DomainScanProgress } from './DomainScanProgress';
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
  /** 顶行左侧分类功能图标（调用方传入 Bounce+svg 块） */
  icon: ReactNode;
  /** 顶行标题（如 t('nav.sentinel')） */
  title: string;
  /** 缺省自动渲染 DomainScoreCard inline；传了则用自定义 */
  score?: ReactNode;
  /** 顶行右侧原有按钮（重扫/刷新等），最右 */
  action: ReactNode;
  /** 重新扫描是否进行中（结果态下的运行反馈） */
  loading?: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源） */
  progress?: number;
  /** 进度条上方状态消息（task.message） */
  progressMessage?: string;
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

/** 顶行：icon + 标题块（标题 + 评分）+ ml-auto 操作按钮 */
function ReportHeaderRow({
  icon,
  title,
  score,
  action,
}: {
  icon: ReactNode;
  title: string;
  score: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-zh-ink">{title}</h1>
        <div className="mt-2">{score}</div>
      </div>
      <div className="ml-auto flex items-center gap-4 shrink-0">{action}</div>
    </div>
  );
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
        return (
          <ResultCard
            key={s.key}
            as={clickable ? 'button' : 'div'}
            variant="stats"
            className="flex-1 min-w-[160px] text-left cursor-pointer hover:border-brand-600 hover:shadow-md transition-all"
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
      {stat.detail.hint && <p className="text-xs text-zh-muted mb-3">{stat.detail.hint}</p>}
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
  icon,
  title,
  score,
  action,
  loading,
  progress,
  progressMessage,
  onBackHome,
  backHomeTitle,
  stats,
  children,
  historyDomain,
  containerClassName = 'h-full w-full bg-zh-bg overflow-auto',
}: ReportShellProps) {
  const t = useT();
  const [expandedStat, setExpandedStat] = useState<ReportStatCard | null>(null);
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
                inline
              />
            )
          }
          action={action}
        />
        <DomainScanProgress
          loading={loading ?? false}
          progress={progress}
          label={progressMessage}
          className="mb-6"
        />
        <ReportStatsRow
          stats={stats}
          expandedKey={expandedStat?.key ?? null}
          onToggle={(next) => setExpandedStat(next)}
        />
        <ReportStatDetail stat={expandedStat} />
        {children}
        <DomainHistoryPanel projectPath={projectPath} domain={historyDomain} />
      </div>
    </div>
  );
}
