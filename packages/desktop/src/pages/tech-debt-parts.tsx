import { useState } from 'react';
import type { TechDebtReportData } from '../types/electron';
import { PipelineTaskEmptyState } from '../components/business/PipelineTaskEmptyState';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SectionTitle } from '../components/ui/SectionTitle';
import { BrandMarkIcon, FeatureIcon, SectionIcon } from '../components/ui/Icons';
import { ACTION_STATUS_CONFIG, DEBT_CATEGORY_CONFIG, DEBT_CATEGORY_ORDER } from './tech-debt-logic';
import {
  TechDebtActionButtons,
  TechDebtActionMetrics,
  TechDebtInterestBreakdown,
} from './tech-debt-parts-action-views';

export { TechDebtCompositionIntroCard } from './tech-debt-parts-cards';

/** 技术债仪表小图标（24×24，线性风格） */
function TechDebtGaugeIcon() {
  return (
    <BrandMarkIcon>
      <path d="M4 19A8 8 0 0 1 20 19" />
      <path d="M12 13V8" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 19h16" />
    </BrandMarkIcon>
  );
}

/** 债务分布卡片：按模块热力图（模块名 + debtShare 占比条 + hotness 提交数） */
export function TechDebtModuleCard({ modules }: { modules: TechDebtReportData['byModule'] }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="mb-6">
      <SectionTitle
        icon={
          <SectionIcon>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
          </SectionIcon>
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
          <SectionIcon>
            <path d="M3 3v18h18" />
            <path d="M7 14l4-5 4 3 5-7" />
          </SectionIcon>
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

type TechDebtAction = TechDebtReportData['actionList'][number];

type TechDebtConfigEntry = { color: string; bg: string; labelKey: string };

/** 头部行：模块名 + 类别徽章 + 推荐徽章 + 复制到 AI + 状态文本 */
function TechDebtActionHeader({
  action,
  catCfg,
  statusCfg,
  onCopyToAi,
}: {
  action: TechDebtAction;
  catCfg: TechDebtConfigEntry;
  statusCfg: TechDebtConfigEntry;
  onCopyToAi?: (action: TechDebtAction) => void;
}) {
  const t = useT();
  return (
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
  action: TechDebtAction;
  onCopyToAi?: (action: TechDebtAction) => void;
  onPlan?: (actionId: string) => void;
  onVerify?: (actionId: string) => void;
  onDismiss?: (actionId: string) => void;
  planLoading?: boolean;
  verifyLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const catCfg = DEBT_CATEGORY_CONFIG[action.category] ?? DEBT_CATEGORY_CONFIG.duplication;
  const statusCfg = ACTION_STATUS_CONFIG[action.status] ?? ACTION_STATUS_CONFIG.pending;
  return (
    <ResultCard>
      <TechDebtActionHeader
        action={action}
        catCfg={catCfg}
        statusCfg={statusCfg}
        onCopyToAi={onCopyToAi}
      />
      <TechDebtActionMetrics action={action} open={open} onToggle={() => setOpen((v) => !v)} />
      {/* 操作按钮区域：pending → 计划偿还，planned/in-progress → 验证完成，repaid/dismissed → 不显示 */}
      {(action.status === 'pending' ||
        action.status === 'planned' ||
        action.status === 'in-progress') && (
        <TechDebtActionButtons
          action={action}
          onPlan={onPlan}
          onVerify={onVerify}
          onDismiss={onDismiss}
          planLoading={planLoading}
          verifyLoading={verifyLoading}
        />
      )}
      {open && <TechDebtInterestBreakdown action={action} />}
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
          <SectionIcon>
            <path d="M9 18h6M10 22h4" />
            <path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0012 2z" />
          </SectionIcon>
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

/** 空态：引导技术债盘点 */
export function TechDebtEmptyState({
  projectPath,
  loading,
  onScan,
}: {
  projectPath: string;
  loading: boolean;
  onScan: () => void;
}) {
  const t = useT();
  return (
    <PipelineTaskEmptyState
      projectPath={projectPath}
      dimension="techdebt"
      taskKind="techdebt"
      titleKey="page.techdebt.empty.title"
      subtitleKey="page.techdebt.empty.subtitle"
      buttonTextKey="page.techdebt.empty.start"
      progressLabelKey="page.techdebt.checking"
      loading={loading}
      onScan={onScan}
      featureList={[
        {
          icon: <TechDebtGaugeIcon />,
          title: t('page.techdebt.feature.index.title'),
          desc: t('page.techdebt.feature.index.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
            </FeatureIcon>
          ),
          title: t('page.techdebt.feature.module.title'),
          desc: t('page.techdebt.feature.module.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M21.21 15.89A10 10 0 118 2.83" />
              <path d="M22 12A10 10 0 0012 2v10z" />
            </FeatureIcon>
          ),
          title: t('page.techdebt.feature.composition.title'),
          desc: t('page.techdebt.feature.composition.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M9 18h6M10 22h4" />
              <path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0012 2z" />
            </FeatureIcon>
          ),
          title: t('page.techdebt.feature.action.title'),
          desc: t('page.techdebt.feature.action.desc'),
        },
      ]}
    />
  );
}
