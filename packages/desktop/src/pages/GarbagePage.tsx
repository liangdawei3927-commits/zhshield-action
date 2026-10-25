import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { useGarbagePage } from './garbage-logic';
import { GarbageEmptyState } from './garbage-empty-state';
import {
  GARBAGE_TYPE_LABEL,
  formatSize,
  GarbageList,
  GarbageActionBar,
  CleanResultBanner,
  RestoreBanner,
  GarbageSkippedNotice,
} from './garbage-parts';
import type {
  GarbageScanReportData,
  GarbageCleanResultData,
  GarbageRestoreResultData,
} from '../types/electron';

interface GarbagePageProps {
  projectPath: string;
}

/**
 * 顶行分类图标 —— 与顶部导航栏「垃圾清理」按钮同一个图形。
 *
 * 此前这里内联了一份绿色垃圾桶 path，与导航栏的垃圾桶是两份实现（形状略有差异）。
 * 现统一走 `NavGlyph navId="garbage"`，图形只存在 NAV_ICON_CONTENT 一处。
 */
function GarbageIcon() {
  return <NavGlyph navId="garbage" />;
}

interface GarbageReportViewProps {
  projectPath: string;
  report: GarbageScanReportData;
  loading: boolean;
  progress: number;
  statusMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「扫描中…」 */
  queued?: boolean;
  /** 停止本次盘点（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  selected: Set<string>;
  cleaning: boolean;
  restoring: boolean;
  cleanResult: GarbageCleanResultData | null;
  restoreResult: GarbageRestoreResultData | null;
  onRescan: () => void;
  onBackHome: () => void;
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  handleClean: () => Promise<void>;
  handleRestore: () => Promise<void>;
  copyAllToAi: (items: GarbageScanReportData['items']) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

/** 四类垃圾统计卡：明细为该类清单，可整份复制给 AI */
function buildGarbageTypeCards({
  report,
  selected,
  t,
  copyAllToAi,
  toggleSelect,
}: {
  report: GarbageScanReportData;
  selected: Set<string>;
  t: (key: string, params?: Record<string, unknown>) => string;
  copyAllToAi: (items: GarbageScanReportData['items']) => void;
  toggleSelect: (id: string) => void;
}): ReportStatCard[] {
  /**
   * 类型卡配色：只区分「影响面大小」，不虚构严重级。
   * - unused-dependency 动的是依赖树（安装体积 + 供应链攻击面）→ warning
   * - 其余三类是仓库内的整洁度问题 → info
   */
  const typeColor = (type: string): string =>
    type === 'unused-dependency' ? 'rgb(var(--zh-warning))' : 'rgb(var(--zh-info))';
  return (
    ['unused-dependency', 'unused-file', 'dead-code', 'duplicate-code'] as const
  ).map((type) => ({
    key: `type-${type}`,
    label: t(GARBAGE_TYPE_LABEL[type] ?? type),
    value: report.summary.byType[type] ?? 0,
    color: typeColor(type),
    detail: {
      items: report.items.filter((i) => i.type === type),
      render: (sub: unknown[]) => (
        <div className="space-y-3">
          <CopyAllToAiButton
            className="ml-auto"
            label={t('page.garbage.copyAllToAi')}
            onClick={() => copyAllToAi(sub as GarbageScanReportData['items'])}
          />
          <GarbageList
            items={sub as GarbageScanReportData['items']}
            selected={selected}
            onToggle={toggleSelect}
          />
        </div>
      ),
    },
  }));
}

/** 垃圾清理报告视图：统计卡 + 结果横幅 + 操作栏 + 清单 */
function GarbageReportView({
  projectPath,
  report,
  loading,
  progress,
  statusMessage,
  queued,
  onCancel,
  stopping,
  selected,
  cleaning,
  restoring,
  cleanResult,
  restoreResult,
  onRescan,
  onBackHome,
  toggleSelect,
  toggleAll,
  handleClean,
  handleRestore,
  copyAllToAi,
  t,
}: GarbageReportViewProps) {
  const typeCards = buildGarbageTypeCards({ report, selected, t, copyAllToAi, toggleSelect });

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="garbage"
      historyDomain="garbage"
      refreshKey={report}
      icon={<GarbageIcon />}
      title={t('page.garbage.done')}
      action={
        <DomainActionButton
          domain="garbage"
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onRescan}
          loading={loading}
          label={t('page.garbage.rescan')}
        />
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={statusMessage}
      stats={[
        { key: 'items', label: t('page.garbage.stats.items'), value: report.items.length },
        {
          key: 'freeable',
          label: t('page.garbage.stats.freeable'),
          value: formatSize(report.summary.size),
          // 可释放空间 = 当前被占用的浪费量，越大越该处理
          color: 'rgb(var(--zh-warning))',
        },
        ...typeCards,
      ]}
    >
      <GarbageSkippedNotice report={report} />
      {restoreResult && <RestoreBanner result={restoreResult} />}
      {cleanResult && (
        <CleanResultBanner
          result={cleanResult}
          onRestore={handleRestore}
          restoring={restoring}
        />
      )}
      <GarbageActionBar
        items={report.items}
        selected={selected}
        onToggleAll={toggleAll}
        onClean={handleClean}
        onCopyAllToAi={() => copyAllToAi(report.items)}
        cleaning={cleaning}
      />
      <GarbageList items={report.items} selected={selected} onToggle={toggleSelect} />
    </ReportShell>
  );
}

export function GarbagePage({ projectPath }: GarbagePageProps) {
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
    selected,
    cleaning,
    restoring,
    cleanResult,
    restoreResult,
    handleScan,
    toggleSelect,
    toggleAll,
    handleClean,
    handleRestore,
    copyAllToAi,
  } = useGarbagePage(projectPath);

  // 详情入口（读回落盘报告 + 快照通道 + 主页/详情切换）统一由 hook 装配
  const detail = useDomainDetailPage({
    projectPath,
    domain: 'garbage',
    liveReport: report,
    loading,
    onScan: handleScan,
  });

  const emptyStateParams = {
    projectPath,
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    onCancel: cancel,
    stopping,
    onScan: detail.startScan,
  };

  if (detail.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="garbage"
        icon={<GarbageIcon />}
        {...detail.snapshotViewProps}
      />
    );
  }

  if (detail.detailReport && !detail.showHome) {
    return (
      <GarbageReportView
        projectPath={projectPath}
        report={detail.detailReport}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        queued={queued}
        onCancel={cancel}
        stopping={stopping}
        selected={selected}
        cleaning={cleaning}
        restoring={restoring}
        cleanResult={cleanResult}
        restoreResult={restoreResult}
        onRescan={handleScan}
        onBackHome={detail.backHome}
        toggleSelect={toggleSelect}
        toggleAll={toggleAll}
        handleClean={handleClean}
        handleRestore={handleRestore}
        copyAllToAi={copyAllToAi}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider key={detail.scanVersion} available={detail.hasDetail} onOpen={detail.openDetail}>
      <ScanEmptyStateBranch
        {...emptyStateParams}
        render={(empty) => <GarbageEmptyState {...empty} />}
      />
    </DetailEntryProvider>
  );
}