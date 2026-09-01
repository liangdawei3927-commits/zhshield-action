import type { InspectionReportData } from '../types/electron';
import { useT } from '../i18n';
import { STATUS_CONFIG } from './inspect-logic';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

/** 放大镜 SVG（线性风格） */
export function MagnifyingGlass() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      {/* 背景光晕 */}
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-warning) / 0.05)" />
      {/* 包裹/文件夹 */}
      <path
        d="M40 55h70a4 4 0 014 4v36a4 4 0 01-4 4H40a4 4 0 01-4-4V59a4 4 0 014-4z"
        fill="rgb(var(--zh-warning) / 0.1)"
        stroke="rgb(var(--zh-warning))"
        strokeWidth="1.8"
      />
      <path
        d="M40 55l10-10h20l10 10"
        stroke="rgb(var(--zh-warning))"
        strokeWidth="1.8"
        fill="none"
      />
      {/* 放大镜 */}
      <circle
        cx="100"
        cy="55"
        r="18"
        fill="none"
        stroke="rgb(var(--zh-warning))"
        strokeWidth="2.5"
      />
      <line
        x1="113"
        y1="68"
        x2="125"
        y2="80"
        stroke="rgb(var(--zh-warning))"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function InspectHeader({
  passCount,
  total,
  loading,
  progressLabel,
  onRescan,
}: {
  passCount: number;
  total: number;
  loading: boolean;
  progressLabel?: string;
  onRescan: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(var(--zh-warning))"
          strokeWidth="1.8"
        >
          <circle cx="11" cy="12" r="2.5" />
          <path d="M13 14l2 2" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.inspect.done')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.inspect.passedCount', { passed: passCount, total })}
        </p>
      </div>
      <PrimaryButton
        className="ml-auto"
        onClick={onRescan}
        loading={loading}
        loadingLabel={progressLabel || t('page.inspect.scanning')}
      >
        {t('page.inspect.scanNow')}
      </PrimaryButton>
    </div>
  );
}

export function ProgressBar({ passCount, total }: { passCount: number; total: number }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="flex items-center gap-6 mb-6">
      <div className="text-center">
        <div className="text-3xl font-bold text-green-700">
          {passCount}/{total}
        </div>
        <div className="text-xs text-zh-muted mt-1">{t('page.inspect.checksPassed')}</div>
      </div>
      <div className="flex-1 h-2.5 rounded-full bg-zh-panel">
        <div
          className="h-full rounded-full bg-gradient-to-r from-green-600 to-green-700 transition-all"
          style={{ width: `${total ? (passCount / total) * 100 : 0}%` }}
        />
      </div>
    </ResultCard>
  );
}

export function CheckList({
  items,
  onCopyToAi,
  onCopyAll,
}: {
  items: InspectionReportData['checks'];
  onCopyToAi: (item: InspectionReportData['checks'][number]) => void;
  onCopyAll: (items: InspectionReportData['checks']) => void;
}) {
  const t = useT();
  const failedCount = items.filter((i) => i.status !== 'pass').length;
  return (
    <ResultCard variant="list" className="overflow-hidden">
      {failedCount > 0 && (
        <div className="flex items-center justify-between px-5 py-3 border-b border-zh-line">
          <span className="text-xs text-zh-muted">
            {t('page.inspect.copyAllPrompt', { count: failedCount })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(items)} />
        </div>
      )}
      {items.map((item, i) => {
        const config = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.fail;
        return (
          <div
            key={item.id}
            className="flex items-center gap-4 px-5 py-4"
            style={{
              borderBottom: i < items.length - 1 ? '1px solid rgb(var(--zh-line))' : 'none',
            }}
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ background: config.bg, color: config.color }}
            >
              {config.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zh-ink-2">{item.name}</span>
                {item.source === 'ai-code-review' && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{
                      background: 'rgb(var(--zh-primary) / 0.1)',
                      color: 'rgb(var(--zh-primary))',
                    }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                    </svg>
                    {t('page.inspect.aiReviewBadge')}
                  </span>
                )}
              </div>
              <div className="text-xs mt-0.5 text-zh-muted">{item.detail}</div>
            </div>
            {item.status !== 'pass' && <CopyToAiButton onClick={() => onCopyToAi(item)} />}
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ background: config.bg, color: config.color }}
            >
              {t(config.labelKey)}
            </span>
          </div>
        );
      })}
    </ResultCard>
  );
}
