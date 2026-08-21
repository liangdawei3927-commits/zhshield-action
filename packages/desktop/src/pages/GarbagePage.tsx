import { useGarbagePage } from './garbage-logic';
import { GarbageEmptyState } from './garbage-empty-state';
import {
  GarbageHeader,
  GarbageStats,
  GarbageList,
  GarbageActionBar,
  CleanResultBanner,
  RestoreBanner,
} from './garbage-parts';

interface GarbagePageProps {
  projectPath: string;
}

export function GarbagePage({ projectPath }: GarbagePageProps) {
  const {
    loading,
    progressLabel,
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
  } = useGarbagePage(projectPath);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <GarbageHeader report={report} loading={loading} progressLabel={progressLabel} onRescan={handleScan} />
          <GarbageStats report={report} />
          {restoreResult && <RestoreBanner result={restoreResult} />}
          {cleanResult && <CleanResultBanner result={cleanResult} onRestore={handleRestore} restoring={restoring} />}
          <GarbageActionBar
            items={report.garbage}
            selected={selected}
            onToggleAll={toggleAll}
            onClean={handleClean}
            cleaning={cleaning}
          />
          <GarbageList items={report.garbage} selected={selected} onToggle={toggleSelect} />
        </div>
      </div>
    );
  }

  return <GarbageEmptyState loading={loading} progressLabel={progressLabel} onScan={handleScan} />;
}
