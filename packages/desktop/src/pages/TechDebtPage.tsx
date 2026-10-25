import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { AlertCircleIcon } from '../components/ui/Icons';
import { useTechDebtPage, debtIndexColor } from './tech-debt-logic';
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

interface TechDebtReportViewProps {
  projectPath: string;
  report: TechDebtReportData;
  loading: boolean;
  progress: number;
  progressMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「检查中…」 */
  queued?: boolean;
  /** 停止本次技术债检查（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
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
}: Pick<
  TechDebtReportViewProps,
  | 'report'
  | 't'
  | 'copyToAi'
  | 'copyAllToAi'
  | 'handlePlan'
  | 'handleVerify'
  | 'handleDismiss'
  | 'planLoading'
  | 'verifyLoading'
>): ReportStatCard[] {
  return [
    {
      key: 'debtIndex',
      label: t('page.techdebt.debtIndex'),
      value: report.debtIndex,
      // 分档函数已在 tech-debt-logic 定义并被单测锁定（<40 绿 / <70 橙 / ≥70 红），
      // 此前只定义没渲染 —— 指数卡与旁边读数一个色，看不出债务轻重。
      color: debtIndexColor(report.debtIndex),
    },
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
      // 待办动作是「要处理的事」，不是好坏评分
      color: 'rgb(var(--zh-warning))',
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

/** 报告级错误横幅：扫描失败但仍有历史数据时 report 会带 error，必须当场显示 */
function TechDebtErrorBanner({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
      <AlertCircleIcon />
      <div>
        <div className="text-sm font-medium text-danger-700">{t('page.techdebt.errorTitle')}</div>
        <div className="text-xs text-danger-500 mt-0.5">{message}</div>
      </div>
    </div>
  );
}

/** 技术债报告视图：统计卡 + 错误横幅 + 模块/构成/类别/行动项卡片 */
function TechDebtReportView({
  projectPath,
  report,
  loading,
  progress,
  progressMessage,
  queued,
  onCancel,
  stopping,
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
      historyDomain="techdebt"
      refreshKey={report}
      icon={<NavGlyph navId="techdebt" />}
      title={t('page.techdebt.done')}
      action={
        <DomainActionButton
          domain="techdebt"
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onRescan}
          loading={loading}
          label={t('page.techdebt.rescan')}
        />
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={progressMessage}
      stats={stats}
    >
      {report.error && <TechDebtErrorBanner message={report.error} />}
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
  const {
    loading,
    progress,
    progressMessage,
    queued,
    report,
    planLoading,
    verifyLoading,
    handleScan,
    handlePlan,
    handleVerify,
    handleDismiss,
    copyToAi,
    copyAllToAi,
    cancel,
    stopping,
  } = useTechDebtPage(projectPath);

  // 详情入口（读回落盘报告 + 快照通道 + 主页/详情切换）统一由 hook 装配
  const detail = useDomainDetailPage({
    projectPath,
    domain: 'techdebt',
    liveReport: report,
    loading,
    onScan: handleScan,
  });

  if (detail.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="techdebt"
        icon={<NavGlyph navId="techdebt" />}
        {...detail.snapshotViewProps}
      />
    );
  }

  if (detail.detailReport && !detail.showHome) {
    return (
      <TechDebtReportView
        projectPath={projectPath}
        report={detail.detailReport}
        loading={loading}
        progress={progress}
        progressMessage={progressMessage}
        queued={queued}
        onCancel={cancel}
        stopping={stopping}
        onRescan={handleScan}
        onBackHome={detail.backHome}
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
    <DetailEntryProvider key={detail.scanVersion} available={detail.hasDetail} onOpen={detail.openDetail}>
      <TechDebtEmptyState
        projectPath={projectPath}
        loading={loading}
        onScan={detail.startScan}
      />
    </DetailEntryProvider>
  );
}