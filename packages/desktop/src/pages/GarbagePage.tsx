import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useDomainDetailPage } from '../hooks/useDomainDetailEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
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

/** 顶行分类图标：绿色垃圾桶（与 GarbageHeader 原标记一致） */
function GarbageIcon() {
  return (
    <PageGlyph bg="success" stroke="success" round>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </PageGlyph>
  );
}

interface GarbageReportViewProps {
  projectPath: string;
  report: GarbageScanReportData;
  loading: boolean;
  progress: number;
  statusMessage: string;
  progressLabel: string;
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
  progressLabel,
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
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={progressLabel || t('page.garbage.scanning')}
        >
          {t('page.garbage.rescan')}
        </PrimaryButton>
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
    progressLabel,
    statusMessage,
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
  const detail = useDomainDetailPage(projectPath, 'garbage', report, loading, handleScan);

  const emptyStateParams = {
    projectPath,
    loading,
    progress,
    statusMessage,
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
        progressLabel={progressLabel}
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
    <DetailEntryProvider available={detail.hasDetail} onOpen={detail.openDetail}>
      <ScanEmptyStateBranch
        {...emptyStateParams}
        render={(empty) => <GarbageEmptyState {...empty} />}
      />
    </DetailEntryProvider>
  );
}