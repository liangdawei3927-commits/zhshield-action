import { useEffect, useState } from 'react';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, ClockGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainSnapshot } from '../hooks/useDomainSnapshot';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { usePerformancePage } from './performance-logic';
import { IssuesPanel } from './performance-parts';
import type { PerformanceReportData } from '../types/electron';

interface PerformancePageProps {
  projectPath: string;
}

export function PerformancePage({ projectPath }: PerformancePageProps) {
  const t = useT();
  // 打开先落在主页（与改动前一致）；历史报告只让详情按钮可见，不自动进详情
  const [showHome, setShowHome] = useState(true);
  const { loading, progress, progressLabel, statusMessage, report, copyToAi, copyAllToAi, handleScan } =
    usePerformancePage(projectPath);

  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。读回上次完整报告（同口径）。
  const savedReport = useSavedDomainReport(projectPath, 'performance', report);
  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, 'performance');

  // 单一判定源：实时结果优先；扫描进行中不拿旧报告顶替
  const detailReport = report ?? (loading ? null : savedReport);
  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫
  const snapshot = useDomainSnapshot(projectPath, 'performance');
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
        dimension="performance"
        icon={
          <PageGlyph bg="warning" stroke="warning">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
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
      <ReportShell
        projectPath={projectPath}
        dimension="performance"
        historyDomain="performance"
        refreshKey={detailReport}
        icon={
          <PageGlyph bg="warning" stroke="warning">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </PageGlyph>
        }
        title={t('page.performance.header.title')}
        action={
          <PrimaryButton
            onClick={handleScan}
            loading={loading}
            loadingLabel={progressLabel || t('page.performance.detecting')}
          >
            {t('page.performance.rescan')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        loading={loading}
        progress={progress}
        progressMessage={statusMessage}
        stats={performanceReportStats(t, detailReport, copyToAi)}
      >
        <IssuesPanel issues={detailReport.issues} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
      </ReportShell>
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={openDetail}>
      <PerformanceEmptyView
        projectPath={projectPath}
        t={t}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        onAction={() => {
          setShowHome(false);
          handleScan();
        }}
      />
    </DetailEntryProvider>
  );
}

type PerformanceState = ReturnType<typeof usePerformancePage>;
type PerformanceT = ReturnType<typeof useT>;

function performanceReportStats(
  t: PerformanceT,
  report: NonNullable<PerformanceState['report']>,
  copyToAi: PerformanceState['copyToAi'],
) {
  const mediumIssues = report.issues.filter((i) => i.severity === 'medium');
  const lowIssues = report.issues.filter((i) => i.severity === 'low');
  // 两张严重度卡的明细子表都是「同一张 IssuesPanel + 按卡过滤 issues」，只有子集不同
  const statDetail = (items: PerformanceReportData['issues']): ReportStatCard['detail'] => ({
    items,
    render: (sub) => {
      const subset = sub as PerformanceReportData['issues'];
      return (
        <IssuesPanel
          issues={subset}
          onCopyToAi={copyToAi}
          onCopyAll={() => void Promise.all(subset.map((i) => copyToAi(i)))}
        />
      );
    },
  });

  return [
    { key: 'total', label: t('page.performance.stats.total'), value: report.issues.length },
    {
      key: 'medium',
      label: t('page.performance.severity.medium'),
      value: mediumIssues.length,
      color: 'rgb(var(--zh-warning))',
      detail: statDetail(mediumIssues),
    },
    {
      key: 'low',
      label: t('page.performance.severity.low'),
      value: lowIssues.length,
      color: 'rgb(var(--zh-info))',
      detail: statDetail(lowIssues),
    },
    {
      key: 'autoFixable',
      label: t('page.performance.autoFixable'),
      value: report.issues.filter((i) => i.autoFixable).length,
      color: 'rgb(var(--zh-success))',
    },
  ];
}

interface PerformanceEmptyViewProps {
  projectPath: string;
  t: PerformanceT;
  loading: boolean;
  progress: number;
  statusMessage: PerformanceState['statusMessage'];
  onAction: () => void;
}

function PerformanceEmptyView({
  projectPath,
  t,
  loading,
  progress,
  statusMessage,
  onAction,
}: PerformanceEmptyViewProps) {
  return (
    <DomainEmptyView
      projectPath={projectPath}
      dimension="performance"
      title={t('page.performance.shell.title')}
      subtitle={t('page.performance.shell.subtitle')}
      features={[
        {
          icon: (
            <FeatureIcon>
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </FeatureIcon>
          ),
          title: t('page.performance.shell.featureComplexity.title'),
          desc: t('page.performance.shell.featureComplexity.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </FeatureIcon>
          ),
          title: t('page.performance.shell.featureReDoS.title'),
          desc: t('page.performance.shell.featureReDoS.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M2 12h6l3-9 4 18 3-9h4" />
            </FeatureIcon>
          ),
          title: t('page.performance.shell.featureModernApi.title'),
          desc: t('page.performance.shell.featureModernApi.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <ClockGlyph />
            </FeatureIcon>
          ),
          title: t('page.performance.shell.featureTimer.title'),
          desc: t('page.performance.shell.featureTimer.desc'),
        },
      ]}
      buttonText={t('page.performance.shell.start')}
      onAction={onAction}
      loading={loading}
      progress={progress}
      progressLabel={t('page.performance.scanning')}
      statusMessage={statusMessage}
    />
  );
}