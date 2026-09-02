import type { BackupRecordData, BackupResultData } from '../types/electron';
import { STATUS_LABEL, TYPE_LABEL, formatTime } from './backup-logic';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { BackupRecordsPanel } from './backup-records';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

export function BackupHeader({
  recordCount,
  isBackingUp,
  onBackup,
}: {
  recordCount: number;
  isBackingUp: boolean;
  onBackup: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-success-50 flex items-center justify-center">
        <svg
          width="24"
          height="24"
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
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.backup.title')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.backup.recordCount', { count: recordCount })}
        </p>
      </div>
      <PrimaryButton
        className="ml-auto"
        onClick={onBackup}
        loading={isBackingUp}
        loadingLabel={t('page.backup.backingUp')}
      >
        {t('page.backup.oneClickBackup')}
      </PrimaryButton>
    </div>
  );
}

export function BackupResultCard({
  result,
  error,
}: {
  result: BackupResultData;
  error: string | null;
}) {
  const t = useT();
  const statusInfo = STATUS_LABEL[result.overallStatus] ?? {
    textKey: result.overallStatus,
    color: 'rgb(var(--zh-muted))',
  };
  return (
    <ResultCard variant="score" className="mb-6">
      <div className="flex items-center gap-4">
        <span className="text-sm font-semibold" style={{ color: statusInfo.color }}>
          {t(statusInfo.textKey)}
        </span>
        <span className="text-xs text-zh-muted">
          {t('page.backup.result.duration', {
            time: formatTime(result.timestamp),
            duration: result.duration,
          })}
        </span>
      </div>
      <div className="flex gap-4 mt-3">
        {result.results.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-xs"
            style={{ color: r.success ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-danger))' }}
          >
            <span>{r.success ? '✓' : '✗'}</span>
            <span>{t(TYPE_LABEL[r.type] ?? r.type)}</span>
            {r.error && <span className="text-danger-500">({r.error})</span>}
          </div>
        ))}
      </div>
      {error && <div className="mt-3 text-xs text-danger-500">{error}</div>}
    </ResultCard>
  );
}

interface RecordsViewProps {
  records: BackupRecordData[];
  isBackingUp: boolean;
  lastResult: BackupResultData | null;
  error: string | null;
  expandedId: string | null;
  deleteTarget: string | null;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onBackup: () => void;
  onDeleteConfirm: () => void;
  onCancelDelete: () => void;
}

/** 记录态：头部 + 最近结果 + 记录列表 + 删除确认 */
export function BackupRecordsView({
  records,
  isBackingUp,
  lastResult,
  error,
  expandedId,
  deleteTarget,
  onToggle,
  onDelete,
  onBackup,
  onDeleteConfirm,
  onCancelDelete,
}: RecordsViewProps) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <BackupHeader recordCount={records.length} isBackingUp={isBackingUp} onBackup={onBackup} />

        {lastResult && <BackupResultCard result={lastResult} error={error} />}

        <BackupRecordsPanel
          records={records}
          expandedId={expandedId}
          onToggle={onToggle}
          onDelete={onDelete}
        />

        <ConfirmDialog
          open={deleteTarget !== null}
          title={t('page.backup.deleteTitle')}
          message={t('page.backup.deleteMessage')}
          confirmLabel={t('common.delete')}
          variant="danger"
          onConfirm={onDeleteConfirm}
          onCancel={onCancelDelete}
        />
      </div>
    </div>
  );
}
