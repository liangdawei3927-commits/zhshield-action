import { useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { AlertCircleIcon } from '../components/ui/Icons';
import { useTechDebtPage } from './tech-debt-logic';
import type { TechDebtReportData } from '../types/electron';
import {
  TechDebtEmptyState,
  TechDebtModuleCard,
  TechDebtCategoryCard,
  TechDebtActionsCard,
  TechDebtCompositionIntroCard,
} from './tech-debt-parts';

interface TechDebtPageProps {
  projectPath: string;
}

/** 技术债仪表小图标（24×24，线性风格） */
function TechDebtGaugeIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgb(var(--zh-brand))"
      strokeWidth="2"
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

interface TechDebtReportViewProps {
  projectPath: string;
  report: TechDebtReportData;
  loading: boolean;
  onRescan: () => void;
  onBackHome: () => void;
  copyToAi: (action: TechDebtReportData['actionList'][number]) => void;
  copyAllToAi: (actions: TechDebtReportData['actionList']) => void;
  handlePlan: (
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  handleVerify: (actionId: string) => Promise<void>;
  handleDismiss: (actionId: string) => Promise<void>;
  planLoading: string | null;
  verifyLoading: string | null;
  t: (key: string, params?: Record<string, unknown>) => string;
}

/** 报告顶行统计卡：指数 / 模块 / 类别 / 行动项（末张卡明细为行动清单） */
function buildTechDebtStats({
  report,
  t,
  copyToAi,
  copyAllToAi,
  handlePlan,
  handleVerify,
  handleDismiss,
  planLoading,
  verifyLoading,
}: {
  report: TechDebtReportData;
  t: (key: string, params?: Record<string, unknown>) => string;
  copyToAi: (action: TechDebtReportData['actionList'][number]) => void;
  copyAllToAi: (actions: TechDebtReportData['actionList']) => void;
  handlePlan: (
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  handleVerify: (actionId: string) => Promise<void>;
  handleDismiss: (actionId: string) => Promise<void>;
  planLoading: string | null;
  verifyLoading: string | null;
}): ReportStatCard[] {
  return [
    { key: 'debtIndex', label: t('page.techdebt.debtIndex'), value: report.debtIndex },
    {
      key: 'modules',
      label: t('page.techdebt.overviewModules'),
      value: report.byModule.length,
    },
    {
      key: 'categories',
      label: t('page.techdebt.overviewCategories'),
      value: report.byCategory.length,
    },
    {
      key: 'actions',
      label: t('page.techdebt.overviewActions'),
      value: report.actionList.length,
      detail: {
        items: report.actionList,
        render: (sub) => (
          <TechDebtActionsCard
            actions={sub as TechDebtReportData['actionList']}
            onCopyToAi={copyToAi}
            onCopyAllToAi={copyAllToAi}
            onPlan={handlePlan}
            onVerify={handleVerify}
            onDismiss={handleDismiss}
            planLoading={planLoading}
            verifyLoading={verifyLoading}
          />
        ),
      },
    },
  ];
}

/** 技术债报告视图：统计卡 + 错误横幅 + 模块/构成/类别/行动项卡片 */
function TechDebtReportView({
  projectPath,
  report,
  loading,
  onRescan,
  onBackHome,
  copyToAi,
  copyAllToAi,
  handlePlan,
  handleVerify,
  handleDismiss,
  planLoading,
  verifyLoading,
  t,
}: TechDebtReportViewProps) {
  const stats = buildTechDebtStats({
    report,
    t,
    copyToAi,
    copyAllToAi,
    handlePlan,
    handleVerify,
    handleDismiss,
    planLoading,
    verifyLoading,
  });

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="techdebt"
      refreshKey={report}
      icon={
        <Bounce className="w-14 h-14 rounded-xl bg-brand-50 flex items-center justify-center">
          <TechDebtGaugeIcon />
        </Bounce>
      }
      title={t('page.techdebt.done')}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={t('page.techdebt.checking')}
        >
          {t('page.techdebt.rescan')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      stats={stats}
    >
      {report.error && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
          <AlertCircleIcon />
          <div>
            <div className="text-sm font-medium text-danger-700">
              {t('page.techdebt.errorTitle')}
            </div>
            <div className="text-xs text-danger-500 mt-0.5">{report.error}</div>
          </div>
        </div>
      )}
      <TechDebtModuleCard modules={report.byModule} />
      <TechDebtCompositionIntroCard />
      <TechDebtCategoryCard categories={report.byCategory} />
      <TechDebtActionsCard
        actions={report.actionList}
        onCopyToAi={copyToAi}
        onCopyAllToAi={copyAllToAi}
        onPlan={handlePlan}
        onVerify={handleVerify}
        onDismiss={handleDismiss}
        planLoading={planLoading}
        verifyLoading={verifyLoading}
      />
    </ReportShell>
  );
}

export function TechDebtPage({ projectPath }: TechDebtPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    loading,
    report,
    planLoading,
    verifyLoading,
    handleScan,
    handlePlan,
    handleVerify,
    handleDismiss,
    copyToAi,
    copyAllToAi,
  } = useTechDebtPage(projectPath);

  // 单一判定源：report 非空 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = report;
  const hasDetail = detailReport !== null;

  if (detailReport && !showHome) {
    return (
      <TechDebtReportView
        projectPath={projectPath}
        report={detailReport}
        loading={loading}
        onRescan={handleScan}
        onBackHome={() => setShowHome(true)}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        handlePlan={handlePlan}
        handleVerify={handleVerify}
        handleDismiss={handleDismiss}
        planLoading={planLoading}
        verifyLoading={verifyLoading}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
      <TechDebtEmptyState
        projectPath={projectPath}
        loading={loading}
        onScan={() => {
          setShowHome(false);
          handleScan();
        }}
      />
    </DetailEntryProvider>
  );
}