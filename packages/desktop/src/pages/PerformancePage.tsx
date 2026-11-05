import { type ReportStatCard } from '../components/business/ReportShell';
import { DomainReportShell } from '../components/business/domain-report-shell';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { NavGlyph } from '../components/business/page-glyph';
import { FeatureIcon } from '../components/ui/Icons';
import { useT } from '../i18n';
import {
  buildCapabilityFeatures,
  buildPlannedCapabilities,
} from '../components/business/capability-features';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { usePerformancePage } from './performance-logic';
import { IssuesPanel } from './performance-parts';
import type { PerformanceReportData } from '../types/electron';

interface PerformancePageProps {
  projectPath: string;
}

export function PerformancePage({ projectPath }: PerformancePageProps) {
  const t = useT();
  const {
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    report,
    copyToAi,
    copyAllToAi,
    handleScan,
  } = usePerformancePage(projectPath);

  // 详情入口（读回落盘报告 + 快照通道 + 主页/详情切换）统一由 hook 装配
  const detail = useDomainDetailPage({
    projectPath,
    domain: 'performance',
    liveReport: report,
    loading,
    onScan: handleScan,
  });

  if (detail.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="performance"
        icon={<NavGlyph navId="performance" />}
        {...detail.snapshotViewProps}
      />
    );
  }

  if (detail.detailReport && !detail.showHome) {
    return (
      <PerformanceDetailView
        projectPath={projectPath}
        t={t}
        detailReport={detail.detailReport}
        backHome={detail.backHome}
        state={{
          loading,
          queued,
          cancel,
          stopping,
          copyToAi,
          copyAllToAi,
          handleScan,
        }}
      />
    );
  }

  return (
    <DetailEntryProvider
      key={detail.scanVersion}
      available={detail.hasDetail}
      onOpen={detail.openDetail}
    >
      <PerformanceEmptyView
        projectPath={projectPath}
        t={t}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        queued={queued}
        queuePosition={queuePosition}
        onCancel={cancel}
        stopping={stopping}
        onAction={detail.startScan}
      />
    </DetailEntryProvider>
  );
}

type PerformanceState = ReturnType<typeof usePerformancePage>;
type PerformanceT = ReturnType<typeof useT>;

/** 详情分支：完整报告视图（统计卡 + 问题面板），PerformancePage 只留分支路由 */
function PerformanceDetailView({
  projectPath,
  t,
  detailReport,
  backHome,
  state,
}: {
  projectPath: string;
  t: PerformanceT;
  detailReport: NonNullable<PerformanceState['report']>;
  backHome: () => void;
  state: Pick<
    PerformanceState,
    'loading' | 'queued' | 'cancel' | 'stopping' | 'copyToAi' | 'copyAllToAi' | 'handleScan'
  >;
}) {
  const { loading, queued, cancel, stopping, copyToAi, copyAllToAi, handleScan } = state;
  return (
    <DomainReportShell
      projectPath={projectPath}
      domain="performance"
      refreshKey={detailReport}
      title={t('page.performance.header.title')}
      actionLabel={t('page.performance.rescan')}
      onAction={handleScan}
      loading={loading}
      queued={queued}
      onCancel={cancel}
      stopping={stopping}
      onBackHome={backHome}
      stats={performanceReportStats(t, detailReport, copyToAi)}
    >
      <IssuesPanel issues={detailReport.issues} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
    </DomainReportShell>
  );
}

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
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  queued?: boolean;
  queuePosition?: number;
  /** 停止本次性能检测（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  onAction: () => void;
}

function PerformanceEmptyView({
  projectPath,
  t,
  loading,
  progress,
  statusMessage,
  queued,
  queuePosition,
  onCancel,
  stopping,
  onAction,
}: PerformanceEmptyViewProps) {
  return (
    <DomainEmptyView
      projectPath={projectPath}
      domain="performance"
      title={t('page.performance.shell.title')}
      subtitle={t('page.performance.shell.subtitle')}
      features={buildCapabilityFeatures('performance', {
        // 图标按能力 id 绑定：注册表决定**渲染哪几项**，图标只负责视觉
        icons: {
          'performance.runtime.nested-loop': (
            <FeatureIcon>
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </FeatureIcon>
          ),
          'performance.build-config': (
            <FeatureIcon>
              <path d="M2 12h6l3-9 4 18 3-9h4" />
            </FeatureIcon>
          ),
          'performance.bundle-size': (
            <FeatureIcon>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </FeatureIcon>
          ),
          'performance.tree-shaking': (
            <FeatureIcon>
              <path d="M12 2L4 6v6c0 5 3.4 9.7 8 10 4.6-.3 8-5 8-10V6l-8-4z" />
            </FeatureIcon>
          ),
          'performance.redos': (
            <FeatureIcon>
              <path d="M12 2L4 6v6c0 5 3.4 9.7 8 10 4.6-.3 8-5 8-10V6l-8-4z" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </FeatureIcon>
          ),
        },
      })}
      planned={buildPlannedCapabilities('performance')}
      buttonText={t('page.performance.shell.start')}
      onAction={onAction}
      queued={queued}
      queuePosition={queuePosition}
      onCancel={onCancel}
      stopping={stopping}
      loading={loading}
      progress={progress}
      statusMessage={statusMessage}
    />
  );
}
