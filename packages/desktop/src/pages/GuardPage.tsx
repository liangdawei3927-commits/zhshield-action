import { useCallback, useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { useGuardPage, buildGuardLevels, deriveGuardStatus } from './guard-logic';
import { GuardStatusBanner, GuardLevels, GuardStats, GuardTable, GuardHistory, GuardConfigCard } from './guard-parts';
import { useNotification } from '../contexts/NotificationContext';
import { useToast } from '../components/ui/Toast';
import { exportHtmlReport } from '../utils/htmlExport';
import type { HtmlReportData } from '@zh/reporter';
import type { GuardReportData } from '../types/electron';

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

export function GuardPage({ projectPath }: GuardPageProps) {
  const t = useT();
  const { loading, progressLabel, report, copyToAi, copyAllToAi, reportFalsePositive, handleScan, history, falsePositiveCount } = useGuardPage(projectPath);
  const levels = buildGuardLevels(history);
  const status = deriveGuardStatus(levels).status;
  const { notify } = useNotification();
  const lastNotifiedTimestampRef = useRef<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (report === null) return;
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
  }, [report, notify]);

  const handleExport = useCallback(async () => {
    if (report == null) return;
    try {
      const ok = await exportHtmlReport(guardReportToHtmlData(report, projectPath), 'guard-report.html');
      if (ok) toast(t('page.guard.exportSuccess', { defaultValue: 'Report exported' }), 'success');
    } catch {
      toast(t('page.guard.exportFailed', { defaultValue: 'Export failed' }), 'error');
    }
  }, [report, projectPath, toast, t]);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <GuardStatusBanner report={report} status={status} loading={loading} progressLabel={progressLabel} onRescan={handleScan} />
          <div className="flex justify-end mb-4">
            <button
              type="button"
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zh-line bg-white hover:bg-zh-panel text-zh-ink-2 cursor-pointer transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t('page.guard.exportReport', { defaultValue: 'Export Report' })}
            </button>
          </div>
          <GuardLevels levels={levels} />
          <GuardStats report={report} />
          <GuardTable report={report} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} onReportFalsePositive={reportFalsePositive} />
          <GuardHistory records={history} onCopyToAi={copyToAi} onReportFalsePositive={reportFalsePositive} falsePositiveCount={falsePositiveCount} />
          <GuardConfigCard />
          <div className="mt-4 text-xs text-zh-muted">
            {t('page.guard.duration', { duration: report.metadata.duration })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 pt-8">
        <GuardStatusBanner report={null} status={status} loading={loading} progressLabel={progressLabel} onRescan={handleScan} />
        <div className="flex justify-end mb-4">
          <button
            type="button"
            disabled
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zh-line bg-white text-zh-muted cursor-not-allowed opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('page.guard.exportReport', { defaultValue: 'Export Report' })}
          </button>
        </div>
        <GuardLevels levels={levels} />
      </div>
      <div className="w-full px-8 pb-10">
        <GuardHistory records={history} onCopyToAi={copyToAi} onReportFalsePositive={reportFalsePositive} falsePositiveCount={falsePositiveCount} />
        <GuardConfigCard />
      </div>
    </div>
  );
}
