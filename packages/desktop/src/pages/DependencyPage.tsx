import { useEffect, useState } from 'react';
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
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainSnapshot } from '../hooks/useDomainSnapshot';
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
  // 打开先落在主页（与改动前一致：report 初值为 null，原本也是停在主页）。
  // 读回的历史报告只让「详情按钮可见」，不把人自动带进详情页。
  const [showHome, setShowHome] = useState(true);

  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。
  // 这里读回该域上次扫描的完整报告（同一份数据，不做字段再造）。
  const savedReport = useSavedDomainReport<DependencyReportData>(projectPath, 'deps', report);
  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, 'deps');

  // 单一判定源：实时结果优先；扫描进行中不拿旧报告顶替（保持「扫描中看进度」）。
  const detailReport = report ?? (loading ? null : savedReport);
  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫。
  // 点详情不该替用户发起检查 —— 要看新结果，由详情页里的「重新检查」自己点。
  const snapshot = useDomainSnapshot(projectPath, 'deps');
  const [showSnapshot, setShowSnapshot] = useState(false);

  const openDetail = () => {
    if (detailReport) {
      setShowHome(false);
      return;
    }
    snapshot.reload();
    setShowSnapshot(true);
  };

  // 实时扫描出结果时进入详情 —— 复刻原有「扫完直接看报告」的行为
  useEffect(() => {
    if (report) {
      setShowHome(false);
      setShowSnapshot(false);
    }
  }, [report]);

  if (showSnapshot) {
    return (
      <DomainSnapshotReport
        projectPath={projectPath}
        dimension="dependencies"
        icon={
          <PageGlyph bg="brand" stroke="brand" round>
            <DependencyGraphGlyph />
          </PageGlyph>
        }
        snapshot={snapshot.snapshot}
        loading={snapshot.loading}
        rescanning={loading}
        onRescan={handleScan}
        onBackHome={() => setShowSnapshot(false)}
      />
    );
  }

  if (detailReport && !showHome) {
    return (
      <DependencyReportView
        report={detailReport}
        loading={loading}
        progress={progress}
        progressMessage={progressMessage}
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
    <DetailEntryProvider available={hasDetail} onOpen={openDetail}>
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
