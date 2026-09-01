import { useCallback, useEffect, useRef } from 'react';
import { useT } from '../i18n';
import {
  useGuardPage,
  buildGuardLevels,
  deriveGuardStatus,
  type GuardLevelInfo,
} from './guard-logic';
import {
  GuardStatusBanner,
  GuardLevels,
  GuardStats,
  GuardTable,
  GuardHistory,
  GuardConfigCard,
} from './guard-parts';
import { useNotification } from '../contexts/NotificationContext';
import { useToast } from '../components/ui/Toast';
import { exportHtmlReport } from '../utils/htmlExport';
import type { HtmlReportData } from '@zh/reporter';
import type { GuardReportData, GuardReportRecordData } from '../types/electron';
import type { AppNotification } from '@zh/kernel';

interface GuardPageProps {
  projectPath: string;
}

function guardReportToHtmlData(report: GuardReportData, projectPath: string): HtmlReportData {
  return {
    timestamp: report.metadata.timestamp,
    projectName: projectPath.split('/').pop() ?? projectPath,
    summary: {
      total: report.summary.totalChecks,
      passed: report.summary.passed,
      warnings: report.summary.warnings,
      failures: report.summary.blocked,
    },
    sections: [
      {
        title: 'Guard Checks',
        items: report.checks.map((c) => ({
          status: c.status,
          message: `[${c.id}] ${c.message}`,
          severity: c.severity,
        })),
      },
    ],
  };
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

async function exportGuardReport(
  report: GuardReportData,
  projectPath: string,
  toast: (msg: string, variant?: 'success' | 'error' | 'warning' | 'info') => void,
  t: (key: string, params?: Record<string, unknown>) => string,
): Promise<void> {
  try {
    const ok = await exportHtmlReport(
      guardReportToHtmlData(report, projectPath),
      'guard-report.html',
    );
    if (ok) toast(t('page.guard.exportSuccess', { defaultValue: 'Report exported' }), 'success');
  } catch {
    toast(t('page.guard.exportFailed', { defaultValue: 'Export failed' }), 'error');
  }
}

function GuardExportButton({
  onClick,
  disabled,
  t,
}: {
  onClick?: () => void;
  disabled?: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <div className="flex justify-end mb-4">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zh-line bg-white ${
          disabled
            ? 'text-zh-muted cursor-not-allowed opacity-50'
            : 'hover:bg-zh-panel text-zh-ink-2 cursor-pointer transition-colors'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {t('page.guard.exportReport', { defaultValue: 'Export Report' })}
      </button>
    </div>
  );
}

function GuardReportView({
  report,
  status,
  loading,
  progressLabel,
  onRescan,
  onExport,
  levels,
  copyToAi,
  copyAllToAi,
  reportFalsePositive,
  history,
  falsePositiveCount,
  t,
}: {
  report: GuardReportData;
  status: 'pass' | 'warn' | 'fail';
  loading: boolean;
  progressLabel: string;
  onRescan: () => void;
  onExport: () => void;
  levels: GuardLevelInfo[];
  copyToAi: (check: GuardReportData['checks'][number]) => void;
  copyAllToAi: (checks: GuardReportData['checks'][number][]) => void;
  reportFalsePositive: (check: GuardReportData['checks'][number]) => void;
  history: GuardReportRecordData[];
  falsePositiveCount: number;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <GuardStatusBanner
          report={report}
          status={status}
          loading={loading}
          progressLabel={progressLabel}
          onRescan={onRescan}
        />
        <GuardExportButton onClick={onExport} t={t} />
        <GuardLevels levels={levels} />
        <GuardStats report={report} />
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
      </div>
    </div>
  );
}

function GuardEmptyView({
  status,
  loading,
  progressLabel,
  onRescan,
  levels,
  copyToAi,
  reportFalsePositive,
  history,
  falsePositiveCount,
  t,
}: {
  status: 'pass' | 'warn' | 'fail';
  loading: boolean;
  progressLabel: string;
  onRescan: () => void;
  levels: GuardLevelInfo[];
  copyToAi: (check: GuardReportData['checks'][number]) => void;
  reportFalsePositive: (check: GuardReportData['checks'][number]) => void;
  history: GuardReportRecordData[];
  falsePositiveCount: number;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 pt-8">
        <GuardStatusBanner
          report={null}
          status={status}
          loading={loading}
          progressLabel={progressLabel}
          onRescan={onRescan}
        />
        <GuardExportButton disabled t={t} />
        <GuardLevels levels={levels} />
      </div>
      <div className="w-full px-8 pb-10">
        <GuardHistory
          records={history}
          onCopyToAi={copyToAi}
          onReportFalsePositive={reportFalsePositive}
          falsePositiveCount={falsePositiveCount}
        />
        <GuardConfigCard />
      </div>
    </div>
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

function useGuardExport(report: GuardReportData | null, projectPath: string): () => Promise<void> {
  const { toast } = useToast();
  const t = useT();
  const handleExport = useCallback(async () => {
    if (report == null) return;
    await exportGuardReport(report, projectPath, toast, t);
  }, [report, projectPath, toast, t]);
  return handleExport;
}

export function GuardPage({ projectPath }: GuardPageProps) {
  const t = useT();
  const {
    loading,
    progressLabel,
    report,
    copyToAi,
    copyAllToAi,
    reportFalsePositive,
    handleScan,
    history,
    falsePositiveCount,
  } = useGuardPage(projectPath);
  const levels = buildGuardLevels(history);
  const status = deriveGuardStatus(levels).status;
  const { notify } = useNotification();
  useGuardBlockNotification(report, notify);
  const handleExport = useGuardExport(report, projectPath);

  if (report) {
    return (
      <GuardReportView
        report={report}
        status={status}
        loading={loading}
        progressLabel={progressLabel}
        onRescan={handleScan}
        onExport={handleExport}
        levels={levels}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        reportFalsePositive={reportFalsePositive}
        history={history}
        falsePositiveCount={falsePositiveCount}
        t={t}
      />
    );
  }

  return (
    <GuardEmptyView
      status={status}
      loading={loading}
      progressLabel={progressLabel}
      onRescan={handleScan}
      levels={levels}
      copyToAi={copyToAi}
      reportFalsePositive={reportFalsePositive}
      history={history}
      falsePositiveCount={falsePositiveCount}
      t={t}
    />
  );
}
