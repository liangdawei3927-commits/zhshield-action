import type { ReactNode } from 'react';
import { ResultCard } from '../ui/ResultCard';
import { PrimaryButton } from '../ui/PrimaryButton';

interface FeatureItem {
  icon: ReactNode;
  title: string;
  desc: string;
}

interface PageShellProps {
  /** 中心 150x150 插图 */
  illustration: ReactNode;
  /** 大标题 24px */
  title: string;
  /** 副标题 14px gray */
  subtitle: string;
  /** 主按钮文字 */
  buttonText: string;
  /** 按钮点击 */
  onAction?: () => void;
  /** 功能清单：这个页面能做什么 */
  featureList?: FeatureItem[];
  /** 是否加载中 */
  loading?: boolean;
  /** 加载时的进度提示文字 */
  progressLabel?: string;
}

/** 中心插图 + 标题区 */
function PageHeading({
  illustration,
  title,
  subtitle,
}: {
  illustration: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <>
      {/* 中心插图 */}
      <div className="w-[150px] h-[150px] flex items-center justify-center mb-6">
        {illustration}
      </div>

      {/* 标题 */}
      <h1 className="text-2xl font-bold text-zh-ink mb-2">{title}</h1>

      {/* 副标题 */}
      <p className="text-sm text-zh-muted mb-6">{subtitle}</p>
    </>
  );
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

/** 底部功能清单 — 网格铺满宽度：图标在前，标题在后 */
function FeatureList({ features }: { features: FeatureItem[] }) {
  return (
    <div className="w-full flex flex-col items-center mt-auto mb-6">
      <div className="grid grid-cols-4 gap-4 w-full px-6">
        {features.map((feature, i) => (
          <ResultCard key={i} variant="item" className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-lg flex items-center justify-center text-brand-700 bg-zh-card shadow-sm shrink-0">
              {feature.icon}
            </span>
            <div className="text-left min-w-0">
              <div className="text-sm font-semibold text-zh-ink leading-tight">{feature.title}</div>
              <div className="text-[11px] text-zh-muted mt-0.5 leading-relaxed">{feature.desc}</div>
            </div>
          </ResultCard>
        ))}
      </div>
    </div>
  );
}

export function PageShell({
  illustration,
  title,
  subtitle,
  buttonText,
  onAction,
  featureList,
  loading = false,
  progressLabel,
}: PageShellProps) {
  return (
    <div className="h-full w-full flex flex-col items-center bg-zh-bg select-none relative overflow-auto">
      {/* 上半部分：插图 + 标题 + 主按钮，垂直居中 */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 min-h-0">
        <PageHeading illustration={illustration} title={title} subtitle={subtitle} />
        <ActionButton
          onClick={onAction}
          disabled={loading}
          buttonText={buttonText}
          loading={loading}
          progressLabel={progressLabel}
        />
      </div>

      {/* 下半部分：功能清单 */}
      {featureList && featureList.length > 0 && <FeatureList features={featureList} />}
    </div>
  );
}
