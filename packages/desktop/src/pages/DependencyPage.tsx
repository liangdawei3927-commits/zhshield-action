import { useState } from 'react';
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
import type { DependencyReportData, TyposquatFindingData } from '../types/electron';

interface DependencyPageProps {
  projectPath: string;
}

function DependencyReportView({
  report,
  loading,
  onRescan,
  onCopyTyposquat,
  onCopyAllTyposquat,
  onBackHome,
  projectPath,
  t,
}: {
  report: DependencyReportData;
  loading: boolean;
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
      stats={[
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
  const { loading, report, handleScan, copyToAi, copyAllToAi } = useDependencyPage(projectPath);
  const t = useT();
  const [showHome, setShowHome] = useState(false);

  // 单一判定源：report 非空 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = report;
  const hasDetail = detailReport !== null;

  if (detailReport && !showHome) {
    return (
      <DependencyReportView
        report={detailReport}
        loading={loading}
        onRescan={handleScan}
        onCopyTyposquat={copyToAi}
        onCopyAllTyposquat={copyAllToAi}
        onBackHome={() => setShowHome(true)}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
      <DependencyEmptyState
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
