import type { TechDebtReportData } from '../types/electron';
import { useT } from '../i18n';
import { INTEREST_FACTOR_CONFIG, INTEREST_FACTOR_MAX } from './tech-debt-logic';

type TechDebtAction = TechDebtReportData['actionList'][number];

/** 指标行：ROI / 利息分 / 本金估算 + 利息明细展开开关 */
export function TechDebtActionMetrics({
  action,
  open,
  onToggle,
}: {
  action: TechDebtAction;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 flex items-center gap-4">
      <span className="text-sm font-bold text-zh-ink">
        {t('page.techdebt.roi', { roi: action.roi })}
      </span>
      <span className="text-xs text-zh-muted">
        {t('page.techdebt.interestScore', { score: action.interestScore })}
      </span>
      <span className="text-xs text-zh-muted">
        {t('page.techdebt.principalEstimate', { value: action.principalEstimate })}
      </span>
      <button
        onClick={onToggle}
        className="ml-auto flex items-center gap-1 text-xs font-medium text-zh-ink-2 bg-zh-panel px-2.5 py-1 rounded-lg border-none cursor-pointer hover:bg-zh-line transition-colors"
      >
        {t('page.techdebt.interestBreakdown')}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}

/** 操作按钮区域：pending → 计划偿还，planned/in-progress → 验证完成 */
export function TechDebtActionButtons({
  action,
  onPlan,
  onVerify,
  onDismiss,
  planLoading,
  verifyLoading,
}: {
  action: TechDebtAction;
  onPlan?: (actionId: string) => void;
  onVerify?: (actionId: string) => void;
  onDismiss?: (actionId: string) => void;
  planLoading?: boolean;
  verifyLoading?: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-3 pt-3 border-t border-zh-line flex items-center gap-2">
      {action.status === 'pending' && (
        <button
          onClick={() => onPlan?.(action.actionId)}
          disabled={planLoading}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border-none cursor-pointer transition-colors"
          style={{
            background: 'rgb(var(--zh-info) / 0.1)',
            color: 'rgb(var(--zh-info))',
            opacity: planLoading ? 0.6 : 1,
          }}
        >
          {planLoading ? t('page.techdebt.action.planning') : t('page.techdebt.action.plan')}
        </button>
      )}
      {(action.status === 'planned' || action.status === 'in-progress') && (
        <button
          onClick={() => onVerify?.(action.actionId)}
          disabled={verifyLoading}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border-none cursor-pointer transition-colors"
          style={{
            background: 'rgb(var(--zh-success) / 0.1)',
            color: 'rgb(var(--zh-success-700))',
            opacity: verifyLoading ? 0.6 : 1,
          }}
        >
          {verifyLoading ? t('page.techdebt.action.verifying') : t('page.techdebt.action.verify')}
        </button>
      )}
      <button
        onClick={() => onDismiss?.(action.actionId)}
        className="px-3 py-1.5 text-xs font-medium rounded-lg border-none cursor-pointer transition-colors ml-auto"
        style={{ background: 'rgb(var(--zh-muted) / 0.08)', color: 'rgb(var(--zh-muted))' }}
      >
        {t('page.techdebt.action.dismiss')}
      </button>
    </div>
  );
}

/** 利息四因子明细网格（展开显示） */
export function TechDebtInterestBreakdown({ action }: { action: TechDebtAction }) {
  const t = useT();
  return (
    <div className="mt-3 pt-3 border-t border-zh-line grid grid-cols-4 gap-4">
      {INTEREST_FACTOR_CONFIG.map((factor) => {
        const value = action.interestBreakdown[factor.key];
        return (
          <div key={factor.key}>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] text-zh-muted">{t(factor.labelKey)}</span>
              <span className="text-xs font-semibold" style={{ color: factor.color }}>
                {value}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-zh-line overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (value / INTEREST_FACTOR_MAX) * 100)}%`,
                  background: factor.color,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
