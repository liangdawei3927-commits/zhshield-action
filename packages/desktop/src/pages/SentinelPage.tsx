import { useEffect, useRef, useState } from 'react';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { FeatureIcon, LayersGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import {
  useSentinelPage,
  deriveSentinelActionState,
  type SentinelEventItem,
  type SentinelActionState,
} from './sentinel-logic';
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

/** 顶行统计卡：总数 / 活跃 / 高危 / 严重，明细为对应事件子集 */
function buildSentinelStats({
  events,
  sorted,
  activeCount,
  highCount,
  criticalCount,
  projectPath,
  t,
}: {
  events: SentinelEventItem[];
  sorted: SentinelEventItem[];
  activeCount: number;
  highCount: number;
  criticalCount: number;
  projectPath: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}): ReportStatCard[] {
  return [
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
  ];
}

/**
 * 详情页视图（导出供行为级门禁直接渲染：主页→详情要点击，静态渲染点不了）。
 *
 * 忙态一律来自 `action`（deriveSentinelActionState 的唯一结果），本页不自己拼
 * `monitoring || loading` —— 两个视图各拼一次就必然分叉（2026-10-26 的主页漏
 * monitoring 就是这么来的）。
 */
export function SentinelReportView({
  events,
  sorted,
  activeCount,
  highCount,
  criticalCount,
  action,
  onRefresh,
  onStopMonitoring,
  onBackHome,
  projectPath,
  t,
}: {
  events: SentinelEventItem[];
  sorted: SentinelEventItem[];
  activeCount: number;
  highCount: number;
  criticalCount: number;
  action: SentinelActionState;
  onRefresh: () => void;
  onStopMonitoring: () => void;
  onBackHome: () => void;
  projectPath: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="sentinel"
      refreshKey={events}
      icon={<NavGlyph navId="sentinel" />}
      title={t('nav.sentinel')}
      action={
        <DomainActionButton
          // 监控中：按钮进入「监控中…」，hover 出「停止」点它即停（监控 5s 一轮自动刷新，
          // 无需再摆刷新入口）；未监控时才退化成一次性刷新。
          domain={action.domain}
          onClick={action.cancellable ? undefined : onRefresh}
          loading={action.busy}
          onCancel={action.cancellable ? onStopMonitoring : undefined}
          stopping={action.stopping}
          label={t('common.refresh')}
        />
      }
      onBackHome={onBackHome}
      stats={buildSentinelStats({
        events,
        sorted,
        activeCount,
        highCount,
        criticalCount,
        projectPath,
        t,
      })}
    >
      <SentinelTimeline events={sorted} />
    </ReportShell>
  );
}

function SentinelEmptyView(props: {
  projectPath: string;
  monitoring: boolean;
  action: SentinelActionState;
  onAction: () => void;
  onStopMonitoring: () => void;
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
      buttonText={props.t('page.sentinel.shell.buttonStart')}
      onAction={props.onAction}
      actionDomain={props.action.domain}
      loading={props.action.busy}
      // 监控中：同一颗按钮 hover 出「停止」，点它真的停掉监视器
      onCancel={props.action.cancellable ? props.onStopMonitoring : undefined}
      stopping={props.action.stopping}
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
  // 打开先落在主页（与其余分类同一口径）：挂载即读回的事件列表只让右上角详情入口
  // 可见，不自动把人带进详情页。开启监控/刷新时由下面的 onAction 切详情。
  const [showHome, setShowHome] = useState(true);
  const {
    events,
    loading,
    monitoring,
    stopping,
    activeCount,
    highCount,
    criticalCount,
    sorted,
    startMonitoring,
    stopMonitoring,
  } = useSentinelPage(projectPath);
  const { notify } = useNotification();
  useSentinelCriticalNotification(events, notify);

  /**
   * 忙态判定**只在这里做一次**（唯一口径）。
   *
   * 哨兵是常驻守护：`monitoring` 才是"在跑"的真实状态，`loading` 只是拉事件
   * 列表那一瞬。此前主页只把 loading 接进按钮（漏了 monitoring），于是监控中
   * 主页按钮不进入忙态 ⇒ 不出「停止」、点了也只是幂等重启 ⇒ 用户表现为
   * "停不掉"。主页与详情页都从这一个 action 取值，口径不再分叉。
   */
  const action = deriveSentinelActionState({ monitoring, loading, stopping });

  // 单一判定源：有事件 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = events.length > 0 ? events : null;
  const hasDetail = detailReport !== null;

  if (hasDetail && !showHome) {
    return (
      <SentinelReportView
        events={events}
        sorted={sorted}
        activeCount={activeCount}
        highCount={highCount}
        criticalCount={criticalCount}
        action={action}
        onRefresh={startMonitoring}
        onStopMonitoring={stopMonitoring}
        onBackHome={() => setShowHome(true)}
        projectPath={projectPath}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
      <SentinelEmptyView
        projectPath={projectPath}
        monitoring={monitoring}
        action={action}
        onAction={() => {
          setShowHome(false);
          startMonitoring();
        }}
        onStopMonitoring={stopMonitoring}
        t={t}
      />
    </DetailEntryProvider>
  );
}
