import type { CSSProperties, ReactNode } from 'react';
import { EntryCard } from '../ui/EntryCard';
import { PrimaryButton } from '../ui/PrimaryButton';
import { SecondaryButton } from '../ui/SecondaryButton';
import { useNavigation } from '../../contexts/NavigationContext';
import { useT } from '../../i18n';

interface FeatureItem {
  icon: ReactNode;
  title: string;
  desc: string;
  /** 图标块主题色/背景（可选；缺省用 EntryCard md 中性默认） */
  iconStyle?: CSSProperties;
}

interface PageShellProps {
  /** 中心插图（150→190 放大档：插槽固定 190x190，内容居中） */
  illustration: ReactNode;
  /** 大标题（28px） */
  title: string;
  /** 副标题（16px gray） */
  subtitle: string;
  /** 主按钮文字 */
  buttonText: string;
  /** 按钮点击 */
  onAction?: () => void;
  /** 功能清单：这个页面能做什么 */
  featureList?: FeatureItem[];
  /** 底部自定义插槽（替代 featureList 网格；如体检页守护者长卡） */
  footer?: ReactNode;
  /** 底部卡片网格列数（默认 4） */
  columns?: 2 | 3 | 4 | 6;
  /** 是否加载中 */
  loading?: boolean;
  /** 加载时的进度提示文字 */
  progressLabel?: string;
  /** 主按钮下方附加内容（如运行进度条 / 警示通知），跟随居中 */
  extra?: ReactNode;
  /** 副操作按钮文字（描边样式，承载「查看报告」等次级动作） */
  secondaryText?: string;
  /** 副操作点击 */
  onSecondary?: () => void;
  /** 副操作是否禁用（默认跟随 loading） */
  secondaryDisabled?: boolean;
}

/** 主操作按钮（含加载态）——统一走全局 PrimaryButton */
function ActionButton({
  onClick,
  disabled,
  buttonText,
  loading,
  progressLabel,
}: {
  onClick?: () => void;
  disabled: boolean;
  buttonText: string;
  loading: boolean;
  progressLabel?: string;
}) {
  return (
    <PrimaryButton
      onClick={onClick}
      disabled={disabled}
      loading={loading}
      loadingLabel={progressLabel}
    >
      {buttonText}
    </PrimaryButton>
  );
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
 * 全站统一页面骨架：所有页面共用同一排版（插图→标题→副标题→主按钮→贴底卡片网格），
 * 切换页面无隔离感。放大档统一：插图槽 190x190 / 标题 28px / 副标题 16px / 主按钮 220x56。
 */
export function PageShell({
  illustration,
  title,
  subtitle,
  buttonText,
  onAction,
  featureList,
  footer,
  columns = 4,
  loading = false,
  progressLabel,
  extra,
  secondaryText,
  onSecondary,
  secondaryDisabled,
}: PageShellProps) {
  const showSecondary = Boolean(secondaryText && onSecondary);
  const t = useT();
  const nav = useNavigation();
  // 右上角报告中心入口：全站页面统一悬挂；报告中心页自身不再重复展示
  const showReportsLink = nav !== null && nav.currentPage !== 'reports';
  return (
    <div className="h-full w-full flex flex-col items-center bg-zh-bg select-none relative overflow-auto">
      {showReportsLink && (
        <button
          type="button"
          onClick={() => nav.navigate('reports')}
          title={t('nav.reports')}
          aria-label={t('nav.reports')}
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
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6M8 13h8M8 17h5" />
          </svg>
        </button>
      )}
      {/* 上半部分：插图 + 标题 + 主按钮，垂直居中 */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 min-h-0">
        {/* 中心插图：直接子级 SVG 统一撑到 190px，覆盖各页 150 定宽属性 */}
        <div className="w-[190px] h-[190px] flex items-center justify-center mb-6 [&>svg]:w-[190px] [&>svg]:h-[190px]">
          {illustration}
        </div>

        {/* 标题 */}
        <h1 className="text-[28px] font-bold text-zh-ink mb-2 leading-tight text-center">{title}</h1>

        {/* 副标题 */}
        <p className="text-base text-zh-muted mb-6 text-center max-w-2xl">{subtitle}</p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <ActionButton
            onClick={onAction}
            disabled={loading}
            buttonText={buttonText}
            loading={loading}
            progressLabel={progressLabel}
          />
          {showSecondary && (
            <SecondaryButton onClick={onSecondary} disabled={secondaryDisabled ?? loading}>
              {secondaryText}
            </SecondaryButton>
          )}
        </div>

        {extra}
      </div>

      {/* 下半部分：功能清单（featureList 网格或自定义 footer 插槽） */}
      {footer}
      {featureList && featureList.length > 0 && (
        <FeatureList features={featureList} columns={columns} />
      )}
    </div>
  );
}