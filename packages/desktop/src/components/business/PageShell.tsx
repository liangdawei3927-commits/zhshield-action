import type { CSSProperties, ReactNode } from 'react';
import { EntryCard } from '../ui/EntryCard';
import { SecondaryButton } from '../ui/SecondaryButton';
import { DomainScanProgress } from './DomainScanProgress';
import { DomainActionButton } from './DomainActionButton';
import type { ActionRunningKey } from './domain-action-text';
import { useDetailEntry } from '../../contexts/DetailEntryContext';
import { useT } from '../../i18n';
interface FeatureItem {
  icon: ReactNode;
  title: string;
  desc: string;
  /** 图标块主题色/背景（可选；缺省用 EntryCard md 中性默认） */
  iconStyle?: CSSProperties;
}

interface PageShellProps {
  /** 中心插图（环类插槽固定 260x260，内容居中） */
  illustration: ReactNode;
  /** 大标题（28px） */
  title: string;
  /** 副标题（16px gray） */
  subtitle: string;
  /** 主按钮文字 */
  buttonText: string;
  /** 按钮点击 */
  onAction?: () => void;
  /**
   * 动作归属（决定按钮运行态文案）。必填：空态按钮与详情页按钮必须同源，
   * 不允许各页面再各自传一句 loading 文案 —— 见 DomainActionButton。
   */
  actionDomain: ActionRunningKey;
  /** 功能清单：这个页面能做什么 */
  featureList?: FeatureItem[];
  /** 底部自定义插槽（替代 featureList 网格） */
  footer?: ReactNode;
  /** 底部卡片网格列数（默认 4） */
  columns?: 2 | 3 | 4 | 6;
  /** 是否加载中 */
  loading?: boolean;
  /**
   * 任务已入队但还没真正开始（主进程并发槽被占）。
   * 按钮据此显示「排队中…」，进度条据此显示「排队中（第 N 位）…」。
   */
  queued?: boolean;
  /** 排队位置（1 起；仅 queued 时有意义） */
  queuePosition?: number;
  /**
   * 停止当前任务。传了就由**主按钮本身**承担停止入口（忙态 hover 显「停止」，
   * 点击取消）；没传表示这个域没有可取消的执行器 —— 不摆一个点了没反应的入口。
   */
  onCancel?: () => void;
  /** 已发出取消、等确认：主按钮显示「停止中…」并禁用 */
  stopping?: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源；百分比换算由 DomainScanProgress 收口） */
  progress?: number;
  /** 进度条上方状态消息（task.message，不重复百分比/按钮文案） */
  progressMessage?: string;
  /** 主按钮下方附加内容（如运行进度条 / 警示通知），跟随居中 */
  extra?: ReactNode;
  /** 副操作按钮文字（描边样式，承载「查看报告」等次级动作） */
  secondaryText?: string;
  /** 副操作点击 */
  onSecondary?: () => void;
  /** 副操作是否禁用（默认跟随 loading） */
  secondaryDisabled?: boolean;
}

/** 底部功能清单 — 全站统一贴底卡片网格（EntryCard md，列数可配置） */
function FeatureList({
  features,
  columns,
}: {
  features: FeatureItem[];
  columns: NonNullable<PageShellProps['columns']>;
}) {
  const columnsClass: Record<NonNullable<PageShellProps['columns']>, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  };
  return (
    <div className="w-full flex flex-col items-center mt-auto mb-10">
      <div className={`grid ${columnsClass[columns]} gap-4 w-full px-6`}>
        {features.map((feature, i) => (
          <EntryCard
            key={i}
            size="md"
            icon={feature.icon}
            title={feature.title}
            sub={feature.desc}
            iconStyle={feature.iconStyle}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 右上角「查看详情」入口：全站页面统一悬挂；是否渲染完全由 DetailEntryContext
 * 决定（页面单一判定 hasDetail 同时控制详情分支与本图标），无数据直接不渲染。
 * 报告中心入口已迁至侧边栏项目行，此处不再负责跳转报告页。
 */
function DetailCornerLink() {
  const t = useT();
  const entry = useDetailEntry();
  if (!entry?.available) return null;
  return (
    <button
      type="button"
      onClick={entry.onOpen}
      title={t('page.detail.view')}
      aria-label={t('page.detail.view')}
      data-testid="page-detail-entry"
      className="absolute top-6 right-6 z-20 w-10 h-10 rounded-full flex items-center justify-center text-brand-600 border border-brand-600 hover:bg-brand-50 hover:text-brand-700 transition-colors cursor-pointer"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

/**
 * 上半区独占的 props：与 {@link PageShellProps} 同源（排队/取消/进度同一套口径），
 * 只多一条「loading 必填」，且不带底部功能网格那几项。
 * 用 Omit 派生而非照抄一份字段清单，避免两处声明随迭代漂移。
 */
type PageHeroProps = Omit<
  PageShellProps,
  'loading' | 'featureList' | 'footer' | 'columns'
> & { loading: boolean };

/** 分数环下钻入口（P2-7）：详情可用时整环可点，与右上角图标同源（DetailEntryContext） */
function IllustrationSlot({ children }: { children: ReactNode }) {
  const t = useT();
  const entry = useDetailEntry();
  if (!entry?.available) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={entry.onOpen}
      title={t('page.detail.view')}
      aria-label={t('page.detail.view')}
      data-testid="score-ring-detail-entry"
      className="w-[260px] h-[260px] rounded-full cursor-pointer transition-transform hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      {children}
    </button>
  );
}

/** 上半部分：插图 + 标题 + 副标题 + 进度 + 主/副按钮 + 附加内容，垂直居中 */
function PageHero({
  illustration,
  title,
  subtitle,
  buttonText,
  onAction,
  actionDomain,
  loading,
  queued = false,
  queuePosition,
  onCancel,
  stopping = false,
  progress,
  progressMessage,
  extra,
  secondaryText,
  onSecondary,
  secondaryDisabled,
}: PageHeroProps) {
  const t = useT();
  const showSecondary = Boolean(secondaryText && onSecondary);
  // 排队时任务还没开始，没有任务消息可显示 —— 进度条报排队位置，
  // 让用户知道"不是卡住了，是在等前面的任务"。
  // ⚠️ 变量名刻意避开 useTaskRun 里那个「含百分比 + 任务消息」的字段名：
  // 该标识符在 domain-action-label 门禁里属于按钮禁区，进度条文案是另一回事。
  const barLabel = queued
    ? t('task.queuedLabel', { position: queuePosition ?? '?' })
    : progressMessage;
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 min-h-0">
      <div className="w-[260px] h-[260px] flex items-center justify-center mb-6 [&>svg]:w-[260px] [&>svg]:h-[260px]">
        <IllustrationSlot>{illustration}</IllustrationSlot>
      </div>
      <h1 className="text-[28px] font-bold text-zh-ink mb-2 leading-tight text-center">{title}</h1>
      <p className="text-base text-zh-muted mb-6 text-center max-w-2xl">{subtitle}</p>
      <DomainScanProgress
        loading={loading || queued}
        progress={progress}
        label={barLabel}
        className="mb-4"
      />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <DomainActionButton
          domain={actionDomain}
          label={buttonText}
          loading={loading}
          queued={queued}
          onCancel={onCancel}
          stopping={stopping}
          onClick={onAction}
        />
        {showSecondary && (
          <SecondaryButton onClick={onSecondary} disabled={secondaryDisabled ?? loading}>
            {secondaryText}
          </SecondaryButton>
        )}
      </div>
      {extra}
    </div>
  );
}

/**
 * 全站统一页面骨架：所有页面共用同一排版（插图→标题→副标题→主按钮→贴底卡片网格），
 * 切换页面无隔离感。放大档统一：插图槽 260x260 / 标题 28px / 副标题 16px / 主按钮 220x56。
 */
export function PageShell({
  illustration,
  title,
  subtitle,
  buttonText,
  onAction,
  actionDomain,
  featureList,
  footer,
  columns = 4,
  loading = false,
  queued = false,
  queuePosition,
  onCancel,
  stopping = false,
  progress,
  progressMessage,
  extra,
  secondaryText,
  onSecondary,
  secondaryDisabled,
}: PageShellProps) {
  return (
    <div className="h-full w-full flex flex-col items-center bg-zh-bg select-none relative overflow-auto">
      <DetailCornerLink />
      <PageHero
        illustration={illustration}
        title={title}
        subtitle={subtitle}
        buttonText={buttonText}
        onAction={onAction}
        actionDomain={actionDomain}
        loading={loading}
        queued={queued}
        queuePosition={queuePosition}
        onCancel={onCancel}
        stopping={stopping}
        progress={progress}
        progressMessage={progressMessage}
        extra={extra}
        secondaryText={secondaryText}
        onSecondary={onSecondary}
        secondaryDisabled={secondaryDisabled}
      />
      {footer}
      {featureList && featureList.length > 0 && (
        <FeatureList features={featureList} columns={columns} />
      )}
    </div>
  );
}
