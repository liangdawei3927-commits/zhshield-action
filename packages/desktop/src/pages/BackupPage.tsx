import { useState } from 'react';
import { useT } from '../i18n';
import { ReportShell } from '../components/business/ReportShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useBackupPage } from './backup-logic';
import { BackupScheduleRow, BackupProgressBar, BackupResultCard } from './backup-parts';
import { BackupRecordsPanel } from './backup-records';
import { BackupEmptyState } from './backup-empty-state';

interface BackupPageProps {
  projectPath: string;
  onNavigate: (page: string) => void;
}

export function BackupPage({ projectPath, onNavigate: _onNavigate }: BackupPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
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

  if ((records.length > 0 || lastResult) && !showHome) {
    const successCount = records.filter((r) => r.status === 'success').length;
    const partialCount = records.filter((r) => r.status === 'partial').length;
    const failedCount = records.filter((r) => r.status === 'failed').length;

    return (
      <ReportShell
        projectPath={projectPath}
        dimension="backup"
        refreshKey={lastResult}
        containerClassName="h-full w-full bg-zh-bg flex flex-col"
        icon={
          <Bounce className="w-14 h-14 rounded-xl bg-success-50 flex items-center justify-center">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgb(var(--zh-brand))"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </Bounce>
        }
        title={t('page.backup.title')}
        action={
          <PrimaryButton
            onClick={handleBackup}
            loading={isBackingUp}
            loadingLabel={t('page.backup.backingUp')}
          >
            {t('page.backup.oneClickBackup')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        stats={[
          { key: 'records', label: t('page.backup.recordsTitle'), value: records.length },
          {
            key: 'success',
            label: t('page.backup.status.success'),
            value: successCount,
            color: 'rgb(var(--zh-success))',
          },
          {
            key: 'partial',
            label: t('page.backup.status.partial'),
            value: partialCount,
            color: 'rgb(var(--zh-warning))',
          },
          {
            key: 'failed',
            label: t('page.backup.status.failed'),
            value: failedCount,
            color: 'rgb(var(--zh-danger))',
          },
        ]}
      >
        {isBackingUp && <BackupProgressBar progress={progress} />}
        {lastResult && <BackupResultCard result={lastResult} error={error} />}
        <BackupRecordsPanel
          records={records}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
          onDelete={setDeleteTarget}
          scheduleHeader={<BackupScheduleRow projectPath={projectPath} />}
        />
        <ConfirmDialog
          open={deleteTarget !== null}
          title={t('page.backup.deleteTitle')}
          message={t('page.backup.deleteMessage')}
          confirmLabel={t('common.delete')}
          variant="danger"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      </ReportShell>
    );
  }

  return (
    <BackupEmptyState
      projectPath={projectPath}
      isBackingUp={isBackingUp}
      progress={progress}
      onBackup={() => {
        setShowHome(false);
        handleBackup();
      }}
    />
  );
}