import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { PageGlyph } from '../components/business/page-glyph';
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
import { useDetailIntentEffect } from '../hooks/useDetailIntent';
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

interface GuardReportViewProps {
  report: GuardReportData;
  loading: boolean;
  progress: number;
  statusMessage: string;
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
}

function buildGuardStats({
  report,
  copyToAi,
  copyAllToAi,
  reportFalsePositive,
  t,
}: {
  report: GuardReportData;
  copyToAi: (check: GuardReportData['checks'][number]) => void;
  copyAllToAi: (checks: GuardReportData['checks'][number][]) => void;
  reportFalsePositive: (check: GuardReportData['checks'][number]) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}): ReportStatCard[] {
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

  return [
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
  ];
}

function GuardReportView({
  report,
  loading,
  progress,
  statusMessage,
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
}: GuardReportViewProps) {
  const stats = buildGuardStats({ report, copyToAi, copyAllToAi, reportFalsePositive, t });

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="gate"
      historyDomain="guard"
      refreshKey={report}
      icon={
        <PageGlyph bg="brand" stroke="brand" round>
          <path d="M12 2L3 7v6c0 5.25 3.83 10.13 9 11.25C17.17 23.13 21 18.25 21 13V7l-9-5z" />
          <path d="M12 6.5l-3 4h2.2L10 14.5l3.5-4.5h-2.2L12 6.5z" />
        </PageGlyph>
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
      loading={loading}
      progress={progress}
      progressMessage={statusMessage}
      stats={stats}
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

function GuardEmptyView(props: {
  projectPath: string;
  loading: boolean;
  progress?: number;
  statusMessage?: string;
  onScan: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <DomainEmptyView
      projectPath={props.projectPath}
      dimension="gate"
      title={props.t('nav.guard')}
      subtitle={props.t('page.guard.idleSubtitle')}
      features={[
        {
          icon: (
            <FeatureIcon>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 01-9 9" />
            </FeatureIcon>
          ),
          title: props.t('page.guard.feature.preCommit.title'),
          desc: props.t('page.guard.feature.preCommit.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </FeatureIcon>
          ),
          title: props.t('page.guard.feature.prePush.title'),
          desc: props.t('page.guard.feature.prePush.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </FeatureIcon>
          ),
          title: props.t('page.guard.feature.ci.title'),
          desc: props.t('page.guard.feature.ci.desc'),
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
          title: props.t('page.guard.feature.manual.title'),
          desc: props.t('page.guard.feature.manual.desc'),
        },
      ]}
      buttonText={props.t('page.guard.scan')}
      onAction={props.onScan}
      loading={props.loading}
      progress={props.progress}
      statusMessage={props.statusMessage}
      progressLabel={props.t('page.guard.scanning')}
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
  // 打开先落在主页（与其余分类同一口径）：挂载即读回的历史报告只让右上角详情入口
  // 可见，不自动把人带进详情页。实时扫描出结果时由下面的 onScan 切详情。
  // 曾经的 false 是在「report 恒为空」年代写的，数据改成挂载即读回后它变成了「直接进详情」。
  const [showHome, setShowHome] = useState(true);
  // 本次跳转带「看结果」意图（扫描进度条点进来）→ 直接展开详情，扫完自动重渲染即进详情
  useDetailIntentEffect('guard', () => setShowHome(false));
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

  // 单一判定源：report 非空 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = report;
  const hasDetail = detailReport !== null;

  if (detailReport && !showHome) {
    return (
      <GuardReportView
        report={detailReport}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
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
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
      <GuardEmptyView
        projectPath={projectPath}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        onScan={() => {
          setShowHome(false);
          handleScan();
        }}
        t={t}
      />
    </DetailEntryProvider>
  );
}
