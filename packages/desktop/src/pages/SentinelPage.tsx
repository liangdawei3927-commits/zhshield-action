import { useCallback, useEffect, useRef } from 'react';
import { PageShell } from '../components/business/PageShell';
import { useT } from '../i18n';
import { useSentinelPage, type SentinelEventItem } from './sentinel-logic';
import { RadarScan, SentinelHeader, SentinelStats, SentinelTimeline, EventsPanel } from './sentinel-parts';
import { useNotification } from '../contexts/NotificationContext';
import { useToast } from '../components/ui/Toast';
import { exportHtmlReport } from '../utils/htmlExport';
import type { HtmlReportData } from '@zh/reporter';
import type { AppNotification } from '@zh/kernel';

interface SentinelPageProps {
  projectPath: string;
}

function sentinelEventsToHtmlData(events: SentinelEventItem[], projectPath: string): HtmlReportData {
  const criticalCount = events.filter((e) => e.severity === 'critical').length;
  const highCount = events.filter((e) => e.severity === 'high').length;
  const mediumCount = events.filter((e) => e.severity === 'medium').length;
  const lowCount = events.filter((e) => e.severity === 'low').length;
  return {
    timestamp: new Date().toISOString(),
    projectName: projectPath.split('/').pop() ?? projectPath,
    summary: {
      total: events.length,
      passed: 0,
      warnings: mediumCount + lowCount,
      failures: criticalCount + highCount,
    },
    sections: [
      {
        title: 'Sentinel Alerts',
        items: events.map((e) => ({
          status: (e.severity === 'critical' || e.severity === 'high' ? 'fail' : e.severity === 'medium' ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail',
          message: `[${e.type}] ${e.title}`,
          file: e.location?.file,
          line: e.location?.line,
          severity: e.severity,
        })),
      },
    ],
  };
}

function notifyCriticalEvents(
  events: SentinelEventItem[],
  notify: (n: AppNotification) => void,
  notifiedIdsRef: React.MutableRefObject<Set<string>>,
): void {
  const newCritical = events.filter((e) => e.severity === 'critical' && !notifiedIdsRef.current.has(e.id));
  for (const event of newCritical) {
    notifiedIdsRef.current.add(event.id);
    notify({
      id: `sentinel-critical-${event.id}`,
      type: 'error',
      title: 'Sentinel Alert',
      message: `${event.title} (${event.type})`,
      timestamp: event.lastSeen,
      read: false,
    });
  }
}

async function exportSentinelReport(
  events: SentinelEventItem[],
  projectPath: string,
  toast: (msg: string, variant?: 'success' | 'error' | 'warning' | 'info') => void,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): Promise<void> {
  if (events.length === 0) return;
  try {
    const ok = await exportHtmlReport(sentinelEventsToHtmlData(events, projectPath), 'sentinel-report.html');
    if (ok) toast(t('page.sentinel.exportSuccess', { defaultValue: 'Report exported' }), 'success');
  } catch {
    toast(t('page.sentinel.exportFailed', { defaultValue: 'Export failed' }), 'error');
  }
}

function SentinelExportButton({ onClick, disabled, t }: { onClick?: () => void; disabled?: boolean; t: (key: string, opts?: { defaultValue?: string }) => string }) {
  return (
    <div className="flex justify-end mb-4">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zh-line bg-white ${
          disabled ? 'text-zh-muted cursor-not-allowed opacity-50' : 'hover:bg-zh-panel text-zh-ink-2 cursor-pointer transition-colors'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {t('page.sentinel.exportReport', { defaultValue: 'Export Report' })}
      </button>
    </div>
  );
}

function SentinelReportView({
  events,
  sorted,
  activeCount,
  highCount,
  criticalCount,
  falsePositiveCount,
  loading,
  onRefresh,
  onExport,
  projectPath,
  t,
}: {
  events: SentinelEventItem[];
  sorted: SentinelEventItem[];
  activeCount: number;
  highCount: number;
  criticalCount: number;
  falsePositiveCount: number;
  loading: boolean;
  onRefresh: () => void;
  onExport: () => void;
  projectPath: string;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <SentinelHeader count={events.length} activeCount={activeCount} loading={loading} onRefresh={onRefresh} />
        <SentinelExportButton onClick={onExport} t={t} />
        <SentinelStats total={events.length} active={activeCount} high={highCount} critical={criticalCount} falsePositive={falsePositiveCount} />
        <SentinelTimeline events={sorted} />
        <EventsPanel events={sorted} projectPath={projectPath} />
      </div>
    </div>
  );
}

function SentinelEmptyView({
  monitoring,
  loading,
  onAction,
  t,
}: {
  monitoring: boolean;
  loading: boolean;
  onAction: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  return (
    <PageShell
      illustration={<RadarScan />}
      title={monitoring ? t('page.sentinel.shell.titleMonitoring') : t('page.sentinel.shell.titleIdle')}
      subtitle={monitoring ? t('page.sentinel.shell.subtitleMonitoring') : t('page.sentinel.shell.subtitleIdle')}
      featureList={[
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          ),
          title: t('page.sentinel.shell.featureRealtime.title'),
          desc: t('page.sentinel.shell.featureRealtime.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          ),
          title: t('page.sentinel.shell.featureAlert.title'),
          desc: t('page.sentinel.shell.featureAlert.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          ),
          title: t('page.sentinel.shell.featureHistory.title'),
          desc: t('page.sentinel.shell.featureHistory.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          ),
          title: t('page.sentinel.shell.featureScope.title'),
          desc: t('page.sentinel.shell.featureScope.desc'),
        },
      ]}
      buttonText={monitoring ? t('page.sentinel.shell.buttonRunning') : t('page.sentinel.shell.buttonStart')}
      onAction={onAction}
      loading={loading}
    />
  );
}

function useSentinelCriticalNotification(events: SentinelEventItem[], notify: (n: AppNotification) => void): void {
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    notifyCriticalEvents(events, notify, notifiedIdsRef);
  }, [events, notify]);
}

function useSentinelExport(events: SentinelEventItem[], projectPath: string): () => Promise<void> {
  const { toast } = useToast();
  const t = useT();
  const handleExport = useCallback(async () => {
    await exportSentinelReport(events, projectPath, toast, t);
  }, [events, projectPath, toast, t]);
  return handleExport;
}

export function SentinelPage({ projectPath }: SentinelPageProps) {
  const t = useT();
  const { events, loading, monitoring, activeCount, highCount, criticalCount, falsePositiveCount, sorted, startMonitoring } = useSentinelPage(projectPath);
  const { notify } = useNotification();
  useSentinelCriticalNotification(events, notify);
  const handleExport = useSentinelExport(events, projectPath);

  if (events.length > 0) {
    return (
      <SentinelReportView
        events={events}
        sorted={sorted}
        activeCount={activeCount}
        highCount={highCount}
        criticalCount={criticalCount}
        falsePositiveCount={falsePositiveCount}
        loading={loading}
        onRefresh={startMonitoring}
        onExport={handleExport}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return <SentinelEmptyView monitoring={monitoring} loading={loading} onAction={startMonitoring} t={t} />;
}
