import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon } from '../components/ui/Icons';
import {
  useGuardPage,
  buildGuardLevels,
  type GuardLevelInfo,
} from './guard-logic';
import {
  GuardLevels,
  GuardTable,
  GuardHistory,
  GuardConfigCard,
} from './guard-parts';
import { useNotification } from '../contexts/NotificationContext';
import type { GuardReportData, GuardReportRecordData } from '../types/electron';
import type { AppNotification } from '@zh/kernel';

interface GuardPageProps {
  projectPath: string;
}

function notifyGuardBlocked(
  report: GuardReportData,
  notify: (n: AppNotification) => void,
  lastNotifiedTimestampRef: React.MutableRefObject<string | null>,
): void {
  if (report.summary.blocked === 0) return;
  if (report.metadata.timestamp === lastNotifiedTimestampRef.current) return;
  lastNotifiedTimestampRef.current = report.metadata.timestamp;

  const blockedChecks = report.checks.filter((c) => c.status === 'fail');
  const criticalCount = blockedChecks.filter((c) => c.severity === 'critical').length;
  const highCount = blockedChecks.filter((c) => c.severity === 'high').length;
  const parts: string[] = [];
  if (criticalCount > 0) parts.push(`${criticalCount} critical`);
  if (highCount > 0) parts.push(`${highCount} high`);
  if (parts.length === 0) parts.push(`${blockedChecks.length} blocked`);

  notify({
    id: `guard-block-${report.metadata.timestamp}`,
    type: 'error',
    title: 'Guard Alert',
    message: `${report.summary.blocked} issue(s) blocked: ${parts.join(', ')}`,
    timestamp: report.metadata.timestamp,
    read: false,
  });
}

function GuardReportView({
  report,
  loading,
  progressLabel,
  onRescan,
  onBackHome,
  levels,
  copyToAi,
  copyAllToAi,
  reportFalsePositive,
  history,
  falsePositiveCount,
  projectPath,
  t,
}: {
  report: GuardReportData;
  loading: boolean;
  progressLabel: string;
  onRescan: () => void;
  onBackHome: () => void;
  levels: GuardLevelInfo[];
  copyToAi: (check: GuardReportData['checks'][number]) => void;
  copyAllToAi: (checks: GuardReportData['checks'][number][]) => void;
  reportFalsePositive: (check: GuardReportData['checks'][number]) => void;
  history: GuardReportRecordData[];
  falsePositiveCount: number;
  projectPath: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const checks = report.checks;
  const passed = checks.filter((c) => c.status === 'pass');
  const warnings = checks.filter((c) => c.status === 'warn');
  const blocked = checks.filter((c) => c.status === 'fail');
  // 四张统计卡的明细子表都是「同一张 GuardTable + 按卡过滤 checks」，只有子集不同
  const tableActions = { copyToAi, copyAllToAi, reportFalsePositive };
  const statDetail = (items: GuardReportData['checks']): ReportStatCard['detail'] => ({
    items,
    render: (sub) => (
      <GuardTable
        report={{ ...report, checks: sub as GuardReportData['checks'] }}
        onCopyToAi={tableActions.copyToAi}
        onCopyAll={tableActions.copyAllToAi}
        onReportFalsePositive={tableActions.reportFalsePositive}
      />
    ),
  });

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="gate"
      refreshKey={report}
      icon={
        <Bounce className="w-14 h-14 rounded-xl bg-brand-50 flex items-center justify-center">
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
            <path d="M12 2L3 7v6c0 5.25 3.83 10.13 9 11.25C17.17 23.13 21 18.25 21 13V7l-9-5z" />
            <path d="M12 6.5l-3 4h2.2L10 14.5l3.5-4.5h-2.2L12 6.5z" />
          </svg>
        </Bounce>
      }
      title={t('nav.guard')}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={progressLabel || t('page.guard.scanning')}
        >
          {t('page.guard.scan')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      stats={[
        {
          key: 'total',
          label: t('page.guard.stats.totalChecks'),
          value: report.summary.totalChecks,
          detail: statDetail(checks),
        },
        {
          key: 'passed',
          label: t('page.guard.stats.passed'),
          value: report.summary.passed,
          color: 'rgb(var(--zh-success))',
          detail: statDetail(passed),
        },
        {
          key: 'warnings',
          label: t('page.guard.stats.warnings'),
          value: report.summary.warnings,
          color: 'rgb(var(--zh-warning))',
          detail: statDetail(warnings),
        },
        {
          key: 'blocked',
          label: t('page.guard.stats.blocked'),
          value: report.summary.blocked,
          color: 'rgb(var(--zh-danger))',
          detail: statDetail(blocked),
        },
      ]}
    >
      <GuardLevels levels={levels} />
      <GuardTable
        report={report}
        onCopyToAi={copyToAi}
        onCopyAll={copyAllToAi}
        onReportFalsePositive={reportFalsePositive}
      />
      <GuardHistory
        records={history}
        onCopyToAi={copyToAi}
        onReportFalsePositive={reportFalsePositive}
        falsePositiveCount={falsePositiveCount}
      />
      <GuardConfigCard />
      <div className="mt-4 text-xs text-zh-muted">
        {t('page.guard.duration', { duration: report.metadata.duration })}
      </div>
    </ReportShell>
  );
}

function GuardEmptyView({
  projectPath,
  loading,
  progress,
  statusMessage,
  onScan,
  t,
}: {
  projectPath: string;
  loading: boolean;
  progress?: number;
  statusMessage?: string;
  onScan: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension="gate" />}
      title={t('nav.guard')}
      subtitle={t('page.guard.idleSubtitle')}
      featureList={[
        {
          icon: (
            <FeatureIcon>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 01-9 9" />
            </FeatureIcon>
          ),
          title: t('page.guard.feature.preCommit.title'),
          desc: t('page.guard.feature.preCommit.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </FeatureIcon>
          ),
          title: t('page.guard.feature.prePush.title'),
          desc: t('page.guard.feature.prePush.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </FeatureIcon>
          ),
          title: t('page.guard.feature.ci.title'),
          desc: t('page.guard.feature.ci.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M19.07 4.93A10 10 0 006.99 3.34" />
              <path d="M4 6h.01" />
              <path d="M2.29 9.62A10 10 0 1021.31 8.35" />
              <path d="M16.24 7.76A6 6 0 108.35 15.65" />
              <path d="M12 18h.01" />
              <path d="M17.99 11.66A6 6 0 0015.77 4.23" />
              <circle cx="12" cy="12" r="2" />
              <path d="M13.41 10.59L17.99 11.66" />
            </FeatureIcon>
          ),
          title: t('page.guard.feature.manual.title'),
          desc: t('page.guard.feature.manual.desc'),
        },
      ]}
      buttonText={t('page.guard.scan')}
      onAction={onScan}
      loading={loading}
      progress={progress}
      progressLabel={t('page.guard.scanning')}
      progressMessage={statusMessage}
    />
  );
}

function useGuardBlockNotification(
  report: GuardReportData | null,
  notify: (n: AppNotification) => void,
): void {
  const lastNotifiedTimestampRef = useRef<string | null>(null);
  useEffect(() => {
    if (report === null) return;
    notifyGuardBlocked(report, notify, lastNotifiedTimestampRef);
  }, [report, notify]);
}

export function GuardPage({ projectPath }: GuardPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    loading,
    progress,
    progressLabel,
    statusMessage,
    report,
    copyToAi,
    copyAllToAi,
    reportFalsePositive,
    handleScan,
    history,
    falsePositiveCount,
  } = useGuardPage(projectPath);
  const levels = buildGuardLevels(history);
  const { notify } = useNotification();
  useGuardBlockNotification(report, notify);

  if (report && !showHome) {
    return (
      <GuardReportView
        report={report}
        loading={loading}
        progressLabel={progressLabel}
        onRescan={handleScan}
        onBackHome={() => setShowHome(true)}
        levels={levels}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        reportFalsePositive={reportFalsePositive}
        history={history}
        falsePositiveCount={falsePositiveCount}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return (
    <GuardEmptyView
      projectPath={projectPath}
      loading={loading}
      progress={Math.round(progress * 100)}
      statusMessage={statusMessage}
      onScan={() => {
        setShowHome(false);
        handleScan();
      }}
      t={t}
    />
  );
}
