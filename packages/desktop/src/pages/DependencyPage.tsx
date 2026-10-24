import { useDependencyPage } from './dependency-logic';
import {
  DependencyEmptyState,
  DependencyLockfileCard,
  DependencyTrustCard,
  DependencyLicenseCard,
  DependencyEnvCard,
  DependencyOutdatedCard,
  DependencyGraphGlyph,
} from './dependency-parts';
import {
  DependencyTyposquatCard,
  DependencyLockfileVerificationCard,
  DependencyUpgradeCard,
} from './dependency-cards';
import { ReportShell } from '../components/business/ReportShell';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { AlertCircleIcon } from '../components/ui/Icons';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import type { DependencyReportData, TyposquatFindingData } from '../types/electron';

interface DependencyPageProps {
  projectPath: string;
}

function DependencyReportView({
  report,
  loading,
  progress,
  progressMessage,
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
      icon={
        <PageGlyph bg="brand" stroke="brand" round>
          <DependencyGraphGlyph />
        </PageGlyph>
      }
      title={t('page.deps.done')}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={t('page.deps.checking')}
        >
          {t('page.deps.rescan')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={progressMessage}
      stats={[
        // 四张卡都是「规模统计」（总数/直接/传递/依赖边），大不等于坏 —— 按统计卡配色约定
        // 只有表达好坏极性的数字才上色，纯计数保持墨色。别把它们当遗漏补成彩色。
        { key: 'total', label: t('page.deps.overviewTotal'), value: report.total },
        { key: 'direct', label: t('page.deps.overviewDirect'), value: report.direct },
        { key: 'transitive', label: t('page.deps.overviewTransitive'), value: report.transitive },
        { key: 'edges', label: t('page.deps.overviewEdges'), value: report.edgeCount },
      ]}
    >
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
    </ReportShell>
  );
}

export function DependencyPage({ projectPath }: DependencyPageProps) {
  const { loading, progress, progressMessage, report, handleScan, copyToAi, copyAllToAi } =
    useDependencyPage(projectPath);
  const t = useT();

  // 详情入口（读回落盘报告 + 快照通道 + 主页/详情切换）统一由 hook 装配，
  // 四个域页面共用同一份实现；页面只声明自己的 domain 与扫描入口。
  const detail = useDomainDetailPage(projectPath, 'deps', report, loading, handleScan);

  if (detail.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="dependencies"
        icon={
          <PageGlyph bg="brand" stroke="brand" round>
            <DependencyGraphGlyph />
          </PageGlyph>
        }
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
    <DetailEntryProvider available={detail.hasDetail} onOpen={detail.openDetail}>
      <DependencyEmptyState
        projectPath={projectPath}
        loading={loading}
        onScan={detail.startScan}
      />
    </DetailEntryProvider>
  );
}
