import { useBackupPage } from './backup-logic';
import { BackupRecordsView } from './backup-parts';
import { BackupEmptyState } from './backup-empty-state';

interface BackupPageProps {
  projectPath: string;
  onNavigate: (page: string) => void;
}

export function BackupPage({ projectPath, onNavigate: _onNavigate }: BackupPageProps) {
  const {
    records,
    isBackingUp,
    lastResult,
    expandedId,
    setExpandedId,
    error,
    deleteTarget,
    setDeleteTarget,
    handleBackup,
    handleDeleteConfirm,
  } = useBackupPage(projectPath);

  if (records.length > 0 || lastResult) {
    return (
      <BackupRecordsView
        records={records}
        isBackingUp={isBackingUp}
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
    );
  }

  return (
    <BackupEmptyState
      isBackingUp={isBackingUp}
      onBackup={handleBackup}
    />
  );
}
