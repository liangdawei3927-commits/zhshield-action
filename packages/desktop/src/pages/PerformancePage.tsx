import { useState } from 'react';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, ClockGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { usePerformancePage } from './performance-logic';
import { IssuesPanel } from './performance-parts';
import type { PerformanceReportData } from '../types/electron';

interface PerformancePageProps {
  projectPath: string;
}

export function PerformancePage({ projectPath }: PerformancePageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const { loading, progress, progressLabel, statusMessage, report, copyToAi, copyAllToAi, handleScan } =
    usePerformancePage(projectPath);

  // 单一判定源：report 非空 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = report;
  const hasDetail = detailReport !== null;

  if (detailReport && !showHome) {
    return (
      <ReportShell
        projectPath={projectPath}
        dimension="performance"
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
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
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