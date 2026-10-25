import { useDependencyPage } from './dependency-logic';
import {
  DependencyEmptyState,
  DependencyLockfileCard,
  DependencyTrustCard,
  DependencyLicenseCard,
  DependencyEnvCard,
  DependencyOutdatedCard,
} from './dependency-parts';
import {
  DependencyTyposquatCard,
  DependencyLockfileVerificationCard,
  DependencyUpgradeCard,
} from './dependency-cards';
import { ReportShell } from '../components/business/ReportShell';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { AlertCircleIcon } from '../components/ui/Icons';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import type { DependencyReportData, TyposquatFindingData } from '../types/electron';

interface DependencyPageProps {
  projectPath: string;
}

/**
 * 顶行统计卡：四张卡都是「规模统计」（总数/直接/传递/依赖边），大不等于坏 —— 按统计卡配色约定
 * 只有表达好坏极性的数字才上色，纯计数保持墨色。别把它们当遗漏补成彩色。
 */
function depsOverviewStats(
  t: (key: string, params?: Record<string, unknown>) => string,
  report: DependencyReportData,
): { key: string; label: string; value: number }[] {
  return [
    { key: 'total', label: t('page.deps.overviewTotal'), value: report.total },
    { key: 'direct', label: t('page.deps.overviewDirect'), value: report.direct },
    { key: 'transitive', label: t('page.deps.overviewTransitive'), value: report.transitive },
    { key: 'edges', label: t('page.deps.overviewEdges'), value: report.edgeCount },
  ];
}

/** 报告正文：错误横幅 + 锁文件/可信度/许可证/仿冒/升级/环境/过期七块卡片 */
function DependencyReportBody({
  report,
  onCopyTyposquat,
  onCopyAllTyposquat,
  t,
}: {
  report: DependencyReportData;
  onCopyTyposquat: (finding: TyposquatFindingData) => void;
  onCopyAllTyposquat: (findings: TyposquatFindingData[]) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <>
      {report.error && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
          <AlertCircleIcon />
          <div>
            <div className="text-sm font-medium text-danger-700">{t('page.deps.errorTitle')}</div>
            <div className="text-xs text-danger-500 mt-0.5">{report.error}</div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <DependencyLockfileCard lockfile={report.lockfile} />
        <DependencyTrustCard trustCounts={report.trustCounts} />
      </div>
      <DependencyLicenseCard matrix={report.licenseMatrix} />
      <div className="grid grid-cols-2 gap-6 my-6">
        <DependencyTyposquatCard
          report={report}
          onCopyToAi={onCopyTyposquat}
          onCopyAll={onCopyAllTyposquat}
        />
        <DependencyLockfileVerificationCard report={report} />
      </div>
      <div className="grid grid-cols-2 gap-6">
        <DependencyUpgradeCard report={report} />
        <DependencyEnvCard report={report} />
      </div>
      <div className="mt-6">
        <DependencyOutdatedCard report={report} />
      </div>
    </>
  );
}

function DependencyReportView({
  report,
  loading,
  progress,
  progressMessage,
  queued,
  onCancel,
  stopping,
  onRescan,
  onCopyTyposquat,
  onCopyAllTyposquat,
  onBackHome,
  projectPath,
  t,
}: {
  report: DependencyReportData;
  loading: boolean;
  progress: number;
  progressMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「检查中…」 */
  queued?: boolean;
  /** 停止本次依赖盘点（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  onRescan: () => void;
  onCopyTyposquat: (finding: TyposquatFindingData) => void;
  onCopyAllTyposquat: (findings: TyposquatFindingData[]) => void;
  onBackHome: () => void;
  projectPath: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="dependencies"
      historyDomain="deps"
      refreshKey={report}
      icon={<NavGlyph navId="deps" />}
      title={t('page.deps.done')}
      action={
        <DomainActionButton
          domain="deps"
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onRescan}
          loading={loading}
          label={t('page.deps.rescan')}
        />
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={progressMessage}
      stats={depsOverviewStats(t, report)}
    >
      <DependencyReportBody
        report={report}
        onCopyTyposquat={onCopyTyposquat}
        onCopyAllTyposquat={onCopyAllTyposquat}
        t={t}
      />
    </ReportShell>
  );
}

export function DependencyPage({ projectPath }: DependencyPageProps) {
  const {
    loading,
    progress,
    progressMessage,
    queued,
    report,
    handleScan,
    copyToAi,
    copyAllToAi,
    cancel,
    stopping,
  } = useDependencyPage(projectPath);
  const t = useT();

  // 详情入口（读回落盘报告 + 快照通道 + 主页/详情切换）统一由 hook 装配，
  // 四个域页面共用同一份实现；页面只声明自己的 domain 与扫描入口。
  const detail = useDomainDetailPage({
    projectPath,
    domain: 'deps',
    liveReport: report,
    loading,
    onScan: handleScan,
  });

  if (detail.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="dependencies"
        icon={<NavGlyph navId="deps" />}
        {...detail.snapshotViewProps}
      />
    );
  }

  if (detail.detailReport && !detail.showHome) {
    return (
      <DependencyReportView
        report={detail.detailReport}
        loading={loading}
        progress={progress}
        progressMessage={progressMessage}
        queued={queued}
        onCancel={cancel}
        stopping={stopping}
        onRescan={handleScan}
        onCopyTyposquat={copyToAi}
        onCopyAllTyposquat={copyAllToAi}
        onBackHome={detail.backHome}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider key={detail.scanVersion} available={detail.hasDetail} onOpen={detail.openDetail}>
      <DependencyEmptyState
        projectPath={projectPath}
        loading={loading}
        onScan={detail.startScan}
      />
    </DetailEntryProvider>
  );
}
