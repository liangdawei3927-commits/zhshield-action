import { useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { ReportShell } from '../components/business/ReportShell';
import { PageGlyph } from '../components/business/page-glyph';
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

// 打开先落主页：读回的备份记录只让详情入口可见，不自动进详情（口径见 nav-items.ts）
export function BackupPage({ projectPath, onNavigate: _onNavigate }: BackupPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(true);
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

  // 单一判定源：有备份记录或最近一次结果 = 有详情（同时决定详情分支与右上角图标）
  const detailReport = records.length > 0 || lastResult ? { records, lastResult } : null;
  const hasDetail = detailReport !== null;

  if (hasDetail && !showHome) {
    return (
      <ReportShell
        projectPath={projectPath}
        dimension="backup"
        refreshKey={lastResult}
        containerClassName="h-full w-full bg-zh-bg flex flex-col"
        icon={
          <PageGlyph bg="success" stroke="brand" round>
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </PageGlyph>
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
        stats={backupReportStats(t, records)}
      >
        <BackupRecordsSection
          t={t}
          projectPath={projectPath}
          isBackingUp={isBackingUp}
          progress={progress}
          lastResult={lastResult}
          error={error}
          records={records}
          expandedId={expandedId}
          setExpandedId={setExpandedId}
          deleteTarget={deleteTarget}
          setDeleteTarget={setDeleteTarget}
          handleDeleteConfirm={handleDeleteConfirm}
        />
      </ReportShell>
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={() => setShowHome(false)}>
      <BackupEmptyState
        projectPath={projectPath}
        isBackingUp={isBackingUp}
        progress={progress}
        onBackup={() => {
          setShowHome(false);
          handleBackup();
        }}
      />
    </DetailEntryProvider>
  );
}

type BackupState = ReturnType<typeof useBackupPage>;
type BackupT = ReturnType<typeof useT>;

function backupReportStats(t: BackupT, records: BackupState['records']) {
  const successCount = records.filter((r) => r.status === 'success').length;
  const partialCount = records.filter((r) => r.status === 'partial').length;
  const failedCount = records.filter((r) => r.status === 'failed').length;

  return [
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
  ];
}

interface BackupRecordsSectionProps {
  t: BackupT;
  projectPath: string;
  isBackingUp: BackupState['isBackingUp'];
  progress: BackupState['progress'];
  lastResult: BackupState['lastResult'];
  error: BackupState['error'];
  records: BackupState['records'];
  expandedId: BackupState['expandedId'];
  setExpandedId: BackupState['setExpandedId'];
  deleteTarget: BackupState['deleteTarget'];
  setDeleteTarget: BackupState['setDeleteTarget'];
  handleDeleteConfirm: BackupState['handleDeleteConfirm'];
}

function BackupRecordsSection({
  t,
  projectPath,
  isBackingUp,
  progress,
  lastResult,
  error,
  records,
  expandedId,
  setExpandedId,
  deleteTarget,
  setDeleteTarget,
  handleDeleteConfirm,
}: BackupRecordsSectionProps) {
  return (
    <>
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
    </>
  );
}