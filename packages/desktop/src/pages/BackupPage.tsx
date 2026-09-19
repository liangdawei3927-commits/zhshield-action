import { useBackupPage } from './backup-logic';
import { BackupRecordsView, BackupScheduleCard } from './backup-parts';
import { BackupEmptyState } from './backup-empty-state';
import { DomainScoreCard } from '../components/DomainScoreCard';

interface BackupPageProps {
  projectPath: string;
  onNavigate: (page: string) => void;
}

export function BackupPage({ projectPath, onNavigate: _onNavigate }: BackupPageProps) {
  const {
    records,
    isBackingUp,
    progress,
    lastResult,
    expandedId,
    setExpandedId,
    error,
    deleteTarget,
    setDeleteTarget,
    handleBackup,
    handleDeleteConfirm,
  } = useBackupPage(projectPath);

  return (
    <div className="h-full w-full flex flex-col">
      <div className="px-8 pt-8 shrink-0">
        <BackupScheduleCard projectPath={projectPath} />
        <div className="mt-4">
          <DomainScoreCard projectPath={projectPath} dimension="backup" />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {records.length > 0 || lastResult ? (
          <BackupRecordsView
            records={records}
            isBackingUp={isBackingUp}
            progress={progress}
            lastResult={lastResult}
            error={error}
            expandedId={expandedId}
            deleteTarget={deleteTarget}
            onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            onDelete={setDeleteTarget}
            onBackup={handleBackup}
            onDeleteConfirm={handleDeleteConfirm}
            onCancelDelete={() => setDeleteTarget(null)}
          />
        ) : (
          <BackupEmptyState isBackingUp={isBackingUp} progress={progress} onBackup={handleBackup} />
        )}
      </div>
    </div>
  );
}
