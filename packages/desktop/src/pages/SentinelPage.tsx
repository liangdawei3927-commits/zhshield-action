import { useEffect, useRef, useState } from 'react';
import { ReportShell } from '../components/business/ReportShell';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, LayersGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import { useSentinelPage, type SentinelEventItem } from './sentinel-logic';
import { SentinelTimeline, EventsPanel } from './sentinel-parts';
import { useNotification } from '../contexts/NotificationContext';
import type { AppNotification } from '@zh/kernel';

interface SentinelPageProps {
  projectPath: string;
}

function notifyCriticalEvents(
  events: SentinelEventItem[],
  notify: (n: AppNotification) => void,
  notifiedIdsRef: React.MutableRefObject<Set<string>>,
): void {
  const newCritical = events.filter(
    (e) => e.severity === 'critical' && !notifiedIdsRef.current.has(e.id),
  );
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

function SentinelReportView({
  events,
  sorted,
  activeCount,
  highCount,
  criticalCount,
  loading,
  onRefresh,
  onBackHome,
  projectPath,
  t,
}: {
  events: SentinelEventItem[];
  sorted: SentinelEventItem[];
  activeCount: number;
  highCount: number;
  criticalCount: number;
  loading: boolean;
  onRefresh: () => void;
  onBackHome: () => void;
  projectPath: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="sentinel"
      refreshKey={events}
      icon={
        <PageGlyph bg="info" stroke="info">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" strokeWidth="1.2" />
          <circle cx="12" cy="12" r="1.5" fill="rgb(var(--zh-info))" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" strokeWidth="1.2" />
        </PageGlyph>
      }
      title={t('nav.sentinel')}
      action={
        <PrimaryButton
          onClick={onRefresh}
          loading={loading}
          loadingLabel={t('page.sentinel.refreshing')}
        >
          {t('common.refresh')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      stats={[
        { key: 'total', label: t('page.sentinel.total'), value: events.length },
        {
          key: 'active',
          label: t('page.sentinel.active'),
          value: activeCount,
          color: 'rgb(var(--zh-warning))',
          detail: {
            items: sorted.filter((e) => ['detected', 'assigned', 'fixing'].includes(e.status)),
            render: (sub) => (
              <EventsPanel events={sub as SentinelEventItem[]} projectPath={projectPath} />
            ),
          },
        },
        {
          key: 'high',
          label: t('page.sentinel.high'),
          value: highCount,
          color: 'rgb(var(--zh-danger))',
          detail: {
            items: sorted.filter((e) => e.severity === 'high'),
            render: (sub) => (
              <EventsPanel events={sub as SentinelEventItem[]} projectPath={projectPath} />
            ),
          },
        },
        {
          key: 'critical',
          label: t('page.sentinel.critical'),
          value: criticalCount,
          color: 'rgb(var(--zh-danger))',
          detail: {
            items: sorted.filter((e) => e.severity === 'critical'),
            render: (sub) => (
              <EventsPanel events={sub as SentinelEventItem[]} projectPath={projectPath} />
            ),
          },
        },
      ]}
    >
      <SentinelTimeline events={sorted} />
    </ReportShell>
  );
}

function SentinelEmptyView(props: {
  projectPath: string;
  monitoring: boolean;
  loading: boolean;
  onAction: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  return (
    <DomainEmptyView
      projectPath={props.projectPath}
      dimension="sentinel"
      title={
        props.monitoring
          ? props.t('page.sentinel.shell.titleMonitoring')
          : props.t('page.sentinel.shell.titleIdle')
      }
      subtitle={
        props.monitoring
          ? props.t('page.sentinel.shell.subtitleMonitoring')
          : props.t('page.sentinel.shell.subtitleIdle')
      }
      features={[
        {
          icon: (
            <FeatureIcon>
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </FeatureIcon>
          ),
          title: props.t('page.sentinel.shell.featureRealtime.title'),
          desc: props.t('page.sentinel.shell.featureRealtime.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </FeatureIcon>
          ),
          title: props.t('page.sentinel.shell.featureAlert.title'),
          desc: props.t('page.sentinel.shell.featureAlert.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </FeatureIcon>
          ),
          title: props.t('page.sentinel.shell.featureHistory.title'),
          desc: props.t('page.sentinel.shell.featureHistory.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <LayersGlyph />
            </FeatureIcon>
          ),
          title: props.t('page.sentinel.shell.featureScope.title'),
          desc: props.t('page.sentinel.shell.featureScope.desc'),
        },
      ]}
      buttonText={
        props.monitoring
          ? props.t('page.sentinel.shell.buttonRunning')
          : props.t('page.sentinel.shell.buttonStart')
      }
      onAction={props.onAction}
      loading={props.loading}
    />
  );
}

function useSentinelCriticalNotification(
  events: SentinelEventItem[],
  notify: (n: AppNotification) => void,
): void {
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    notifyCriticalEvents(events, notify, notifiedIdsRef);
  }, [events, notify]);
}

export function SentinelPage({ projectPath }: SentinelPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    events,
    loading,
    monitoring,
    activeCount,
    highCount,
    criticalCount,
    sorted,
    startMonitoring,
  } = useSentinelPage(projectPath);
  const { notify } = useNotification();
  useSentinelCriticalNotification(events, notify);

  if (events.length > 0 && !showHome) {
    return (
      <SentinelReportView
        events={events}
        sorted={sorted}
        activeCount={activeCount}
        highCount={highCount}
        criticalCount={criticalCount}
        loading={loading}
        onRefresh={startMonitoring}
        onBackHome={() => setShowHome(true)}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return (
    <SentinelEmptyView
      projectPath={projectPath}
      monitoring={monitoring}
      loading={loading}
      onAction={() => {
        setShowHome(false);
        startMonitoring();
      }}
      t={t}
    />
  );
}
