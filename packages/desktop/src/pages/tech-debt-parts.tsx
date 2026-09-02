import { useState, type ReactNode } from 'react';
import type { TechDebtReportData } from '../types/electron';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import {
  ACTION_STATUS_CONFIG,
  DEBT_CATEGORY_CONFIG,
  DEBT_CATEGORY_ORDER,
  INTEREST_FACTOR_CONFIG,
  INTEREST_FACTOR_MAX,
  debtIndexColor,
} from './tech-debt-logic';

/** 债务计量插图（150×150，线性风格：仪表 + 上升箭头） */
export function TechDebtIllustration() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-brand) / 0.05)" />
      <circle cx="75" cy="75" r="55" fill="rgb(var(--zh-brand) / 0.03)" />
      {/* 债务仪表：半圆弧刻度 */}
      <path
        d="M35 105 A40 40 0 0 1 115 105"
        stroke="rgb(var(--zh-brand-lighter))"
        strokeWidth="8"
        strokeLinecap="round"
      />
      {/* 仪表指针（指向高位 = 债务偏重） */}
      <path
        d="M75 105 L87 72"
        stroke="rgb(var(--zh-danger))"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="75" cy="105" r="5" fill="rgb(var(--zh-brand))" />
      {/* 上升债务箭头 */}
      <path
        d="M52 38h24M52 38l10-10M52 38l10 10"
        stroke="rgb(var(--zh-warning))"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 底座金币堆 */}
      <circle cx="55" cy="120" r="6" fill="rgb(var(--zh-warning) / 0.25)" />
      <circle cx="75" cy="122" r="6" fill="rgb(var(--zh-warning) / 0.35)" />
      <circle cx="95" cy="120" r="6" fill="rgb(var(--zh-warning) / 0.25)" />
    </svg>
  );
}

/** 技术债仪表小图标（24×24，线性风格） */
function TechDebtGaugeIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgb(var(--zh-brand))"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19A8 8 0 0 1 20 19" />
      <path d="M12 13V8" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 19h16" />
    </svg>
  );
}

/** 页面头部：图标 + 标题 + 摘要（债务指数 + 趋势）+ 重新盘点按钮（含错误横幅） */
export function TechDebtHeader({
  report,
  loading,
  onRescan,
}: {
  report: TechDebtReportData;
  loading: boolean;
  onRescan: () => void;
}) {
  const t = useT();
  return (
    <div className="mb-8">
      <div className="flex items-center gap-4">
        <Bounce className="w-12 h-12 rounded-xl bg-brand-50 flex items-center justify-center">
          <TechDebtGaugeIcon />
        </Bounce>
        <div>
          <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.techdebt.done')}</h1>
          <p className="text-sm text-zh-muted">
            {t('page.techdebt.summary', {
              index: report.debtIndex,
              actions: report.actionList.length,
            })}
          </p>
        </div>
        <PrimaryButton
          className="ml-auto"
          onClick={onRescan}
          loading={loading}
          loadingLabel={t('page.techdebt.checking')}
        >
          {t('page.techdebt.rescan')}
        </PrimaryButton>
      </div>
      {report.error && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgb(var(--zh-danger))"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <div>
            <div className="text-sm font-medium text-danger-700">{t('page.techdebt.errorTitle')}</div>
            <div className="text-xs text-danger-500 mt-0.5">{report.error}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({
  icon,
  label,
  right,
}: {
  icon: ReactNode;
  label: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="w-6 h-6 rounded-md bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
        {icon}
      </span>
      <span className="text-sm font-semibold text-zh-ink-2">{label}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

/** 趋势文案：delta > 0 恶化（红）/ < 0 改善（绿）/ = 0 持平（灰） */
function TrendBadge({ trend }: { trend: TechDebtReportData['trend'] }) {
  const t = useT();
  const delta = trend.delta;
  if (delta > 0) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-danger-50 text-danger-700">
        ↑ {t('page.techdebt.trend.worse', { delta })}
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span
        className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-success-50"
        style={{ color: 'rgb(var(--zh-success-700))' }}
      >
        ↓ {t('page.techdebt.trend.better', { delta: Math.abs(delta) })}
      </span>
    );
  }
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zh-panel"
      style={{ color: 'rgb(var(--zh-muted))' }}
    >
      {t('page.techdebt.trend.flat')}
    </span>
  );
}

/** 债务指数仪表（0-100 加速球式圆环：指数越高债务越重 → 颜色转红） */
function DebtGauge({ index }: { index: number }) {
  const t = useT();
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (index / 100) * circumference;
  const color = debtIndexColor(index);
  return (
    <div
      className="relative flex items-center justify-center shrink-0"
      style={{ width: 160, height: 160 }}
    >
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="rgb(var(--zh-brand-lighter))"
          strokeWidth="8"
        />
        <circle
          cx="50"
          cy="50"
          r="38"
          fill="none"
          stroke="rgb(var(--zh-brand-lighter))"
          strokeWidth="3"
        />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-bold leading-none" style={{ fontSize: 35, color }}>
          {index}
        </span>
        <span className="text-xs text-zh-muted mt-1.5">{t('page.techdebt.debtIndex')}</span>
      </div>
    </div>
  );
}

/** 债务总览卡片：债务指数大数字（加速球式）+ 趋势 delta */
export function TechDebtOverviewCard({ report }: { report: TechDebtReportData }) {
  const t = useT();
  const periodKey =
    report.trend.period === 'quarter'
      ? 'page.techdebt.trend.period.quarter'
      : report.trend.period === 'month'
        ? 'page.techdebt.trend.period.month'
        : 'page.techdebt.trend.period.week';
  return (
    <ResultCard variant="score" className="mb-6">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19A8 8 0 0 1 20 19" />
            <path d="M12 13V8" />
            <circle cx="12" cy="6" r="1.5" />
            <path d="M4 19h16" />
          </svg>
        }
        label={t('page.techdebt.overview')}
        right={<span className="text-xs text-zh-muted">{t(periodKey)}</span>}
      />
      <div className="flex items-center gap-10">
        <DebtGauge index={report.debtIndex} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm font-semibold text-zh-ink-2">
              {t('page.techdebt.trendLabel')}
            </span>
            <TrendBadge trend={report.trend} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-2xl font-bold text-zh-ink leading-none">
                {report.byModule.length}
              </div>
              <div className="text-xs text-zh-muted mt-1.5">
                {t('page.techdebt.overviewModules')}
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-zh-ink leading-none">
                {report.byCategory.length}
              </div>
              <div className="text-xs text-zh-muted mt-1.5">
                {t('page.techdebt.overviewCategories')}
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-zh-ink leading-none">
                {report.actionList.length}
              </div>
              <div className="text-xs text-zh-muted mt-1.5">
                {t('page.techdebt.overviewActions')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ResultCard>
  );
}

/** 债务分布卡片：按模块热力图（模块名 + debtShare 占比条 + hotness 提交数） */
export function TechDebtModuleCard({ modules }: { modules: TechDebtReportData['byModule'] }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="mb-6">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
          </svg>
        }
        label={t('page.techdebt.byModule')}
        right={<span className="text-xs text-zh-muted">{t('page.techdebt.moduleHint')}</span>}
      />
      {modules.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-success-700">{t('page.techdebt.noDebt')}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {modules.map((m) => (
            <div key={m.module} className="flex items-center gap-3">
              <span
                className="text-xs text-zh-ink-2 font-medium truncate shrink-0"
                style={{ width: '38%' }}
                title={m.module}
              >
                {m.module}
              </span>
              <div className="flex-1 h-2.5 rounded-full bg-zh-panel overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, m.debtShare * 100)}%`,
                    background: 'rgb(var(--zh-brand))',
                  }}
                />
              </div>
              <span className="text-[11px] text-zh-muted shrink-0">
                {t('page.techdebt.moduleHotness', { count: m.hotness })}
              </span>
              <span className="text-xs font-semibold text-zh-ink-2 shrink-0 w-12 text-right">
                {Math.round(m.debtShare * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </ResultCard>
  );
}

/** 债务构成卡片：按类型占比条（类别 + count + weight） */
export function TechDebtCategoryCard({
  categories,
}: {
  categories: TechDebtReportData['byCategory'];
}) {
  const t = useT();
  const totalCount = categories.reduce((acc, c) => acc + c.count, 0);
  return (
    <ResultCard variant="score" className="mb-6">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 3v18h18" />
            <path d="M7 14l4-5 4 3 5-7" />
          </svg>
        }
        label={t('page.techdebt.byCategory')}
        right={
          <span className="text-xs text-zh-muted">
            {t('page.techdebt.categoryTotal', { count: totalCount })}
          </span>
        }
      />
      <div className="space-y-3.5">
        {DEBT_CATEGORY_ORDER.map((cat) => {
          const item = categories.find((c) => c.category === cat);
          const cfg = DEBT_CATEGORY_CONFIG[cat] ?? DEBT_CATEGORY_CONFIG.duplication;
          const count = item?.count ?? 0;
          const weight = item?.weight ?? 0;
          return (
            <div key={cat} className="flex items-center gap-3">
              <span className="text-sm text-zh-ink-2 shrink-0 w-24">{t(cfg.labelKey)}</span>
              <div className="flex-1 h-2.5 rounded-full bg-zh-panel overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, weight * 100)}%`, background: cfg.color }}
                />
              </div>
              <span className="text-sm font-semibold text-zh-ink shrink-0 w-8 text-right">
                {count}
              </span>
              <span className="text-[11px] text-zh-muted shrink-0 w-16 text-right">
                {t('page.techdebt.categoryWeight', { weight: Math.round(weight * 100) })}
              </span>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}

/** 单条偿还建议：ROI + 模块 + 类别 + 本金（估算）+ 利息四因子（可展开）+ 操作按钮 */
function TechDebtActionItem({
  action,
  onCopyToAi,
  onPlan,
  onVerify,
  onDismiss,
  planLoading,
  verifyLoading,
}: {
  action: TechDebtReportData['actionList'][number];
  onCopyToAi?: (action: TechDebtReportData['actionList'][number]) => void;
  onPlan?: (actionId: string) => void;
  onVerify?: (actionId: string) => void;
  onDismiss?: (actionId: string) => void;
  planLoading?: boolean;
  verifyLoading?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const catCfg = DEBT_CATEGORY_CONFIG[action.category] ?? DEBT_CATEGORY_CONFIG.duplication;
  const statusCfg = ACTION_STATUS_CONFIG[action.status] ?? ACTION_STATUS_CONFIG.pending;
  return (
    <ResultCard>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zh-ink-2 truncate" title={action.module}>
          {action.module}
        </span>
        <span
          className="px-2 py-0.5 rounded text-xs font-medium shrink-0"
          style={{ background: catCfg.bg, color: catCfg.color }}
        >
          {t(catCfg.labelKey)}
        </span>
        {action.recommended && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-brand-50 text-brand-700 shrink-0">
            {t('page.techdebt.recommended')}
          </span>
        )}
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi?.(action)} />
        <span className="text-[11px] shrink-0" style={{ color: statusCfg.color }}>
          {t(statusCfg.labelKey)}
        </span>
      </div>
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
          onClick={() => setOpen((v) => !v)}
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
      {/* 操作按钮区域：pending → 计划偿还，planned/in-progress → 验证完成，repaid/dismissed → 不显示 */}
      {(action.status === 'pending' ||
        action.status === 'planned' ||
        action.status === 'in-progress') && (
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
              {verifyLoading
                ? t('page.techdebt.action.verifying')
                : t('page.techdebt.action.verify')}
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
      )}
      {open && (
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
                <div className="mt-1 h-1 rounded-full bg-zh-panel overflow-hidden">
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
      )}
    </ResultCard>
  );
}

/** Top 建议清单卡片：按 ROI 排序的偿还建议 */
export function TechDebtActionsCard({
  actions,
  onCopyToAi,
  onCopyAllToAi,
  onPlan,
  onVerify,
  onDismiss,
  planLoading,
  verifyLoading,
}: {
  actions: TechDebtReportData['actionList'];
  onCopyToAi?: (action: TechDebtReportData['actionList'][number]) => void;
  onCopyAllToAi?: (actions: TechDebtReportData['actionList']) => void;
  onPlan?: (
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  onVerify?: (actionId: string) => Promise<void>;
  onDismiss?: (actionId: string) => Promise<void>;
  planLoading?: string | null;
  verifyLoading?: string | null;
}) {
  const t = useT();
  const sorted = actions.toSorted((a, b) => b.roi - a.roi);
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18h6M10 22h4" />
            <path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0012 2z" />
          </svg>
        }
        label={t('page.techdebt.topActions')}
        right={
          sorted.length > 0 ? (
            <CopyAllToAiButton onClick={() => onCopyAllToAi?.(sorted)} />
          ) : (
            <span className="text-xs text-zh-muted">{t('page.techdebt.topActionsHint')}</span>
          )
        }
      />
      {sorted.length === 0 ? (
        <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
          <span className="text-2xl">🟢</span>
          <span className="text-sm font-medium text-success-700">{t('page.techdebt.noDebt')}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((action) => (
            <TechDebtActionItem
              key={action.actionId}
              action={action}
              onCopyToAi={onCopyToAi}
              onPlan={onPlan}
              onVerify={onVerify}
              onDismiss={onDismiss}
              planLoading={planLoading === action.actionId}
              verifyLoading={verifyLoading === action.actionId}
            />
          ))}
        </div>
      )}
    </ResultCard>
  );
}

/** 债务构成介绍卡片：5 类债务的图标 + 名称 + 简介 */
export function TechDebtCompositionIntroCard() {
  const t = useT();
  return (
    <ResultCard variant="score" className="mt-6">
      <SectionTitle
        icon={
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        }
        label={t('page.techdebt.intro.title')}
      />
      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        {DEBT_CATEGORY_ORDER.map((cat) => {
          const cfg = DEBT_CATEGORY_CONFIG[cat] ?? DEBT_CATEGORY_CONFIG.duplication;
          return (
            <div key={cat} className="flex items-start gap-3">
              <span
                className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: cfg.color }}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zh-ink-2">{t(cfg.labelKey)}</div>
                <div className="text-xs text-zh-muted mt-0.5 leading-relaxed">
                  {t(`page.techdebt.categoryDesc.${cat}`)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}

/** 空态：引导技术债盘点 */
export function TechDebtEmptyState({ loading, onScan }: { loading: boolean; onScan: () => void }) {
  const t = useT();
  return (
    <PageShell
      illustration={<TechDebtIllustration />}
      title={t('page.techdebt.empty.title')}
      subtitle={t('page.techdebt.empty.subtitle')}
      featureList={[
        {
          icon: <TechDebtGaugeIcon />,
          title: t('page.techdebt.feature.index.title'),
          desc: t('page.techdebt.feature.index.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
            </svg>
          ),
          title: t('page.techdebt.feature.module.title'),
          desc: t('page.techdebt.feature.module.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.21 15.89A10 10 0 118 2.83" />
              <path d="M22 12A10 10 0 0012 2v10z" />
            </svg>
          ),
          title: t('page.techdebt.feature.composition.title'),
          desc: t('page.techdebt.feature.composition.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18h6M10 22h4" />
              <path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0012 2z" />
            </svg>
          ),
          title: t('page.techdebt.feature.action.title'),
          desc: t('page.techdebt.feature.action.desc'),
        },
      ]}
      buttonText={t('page.techdebt.empty.start')}
      onAction={onScan}
      loading={loading}
      progressLabel={t('page.techdebt.checking')}
    />
  );
}
