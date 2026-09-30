import { useState } from 'react';
import { useT } from '../i18n';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { Bounce } from '../components/ui/Bounce';
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
import type { GarbageScanReportData } from '../types/electron';

interface GarbagePageProps {
  projectPath: string;
}

/** 顶行分类图标：绿色垃圾桶（与 GarbageHeader 原标记一致） */
function GarbageIcon() {
  return (
    <Bounce className="w-14 h-14 rounded-xl bg-success-50 flex items-center justify-center">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgb(var(--zh-success))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </Bounce>
  );
}

export function GarbagePage({ projectPath }: GarbagePageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
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

  const startScan = () => {
    setShowHome(false);
    handleScan();
  };
  const emptyStateParams = {
    projectPath,
    loading,
    progress,
    statusMessage,
    onScan: startScan,
  };

  if (report && !showHome) {
    const typeCards: ReportStatCard[] = (
      ['unused-dependency', 'unused-file', 'dead-code', 'duplicate-code'] as const
    ).map((type) => ({
      key: `type-${type}`,
      label: t(GARBAGE_TYPE_LABEL[type] ?? type),
      value: report.summary.byType[type] ?? 0,
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

    return (
      <ReportShell
        projectPath={projectPath}
        dimension="garbage"
        refreshKey={report}
        icon={<GarbageIcon />}
        title={t('page.garbage.done')}
        action={
          <PrimaryButton
            onClick={handleScan}
            loading={loading}
            loadingLabel={progressLabel || t('page.garbage.scanning')}
          >
            {t('page.garbage.rescan')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        stats={[
          { key: 'items', label: t('page.garbage.stats.items'), value: report.items.length },
          {
            key: 'freeable',
            label: t('page.garbage.stats.freeable'),
            value: formatSize(report.summary.size),
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

  return (
    <ScanEmptyStateBranch
      {...emptyStateParams}
      render={(empty) => <GarbageEmptyState {...empty} />}
    />
  );
}