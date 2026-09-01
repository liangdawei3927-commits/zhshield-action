import type { BackupRecordData } from '../types/electron';
import { Bounce, BounceCard } from '../components/ui/Bounce';
import { ResultCard } from '../components/ui/ResultCard';
import { STATUS_LABEL, TYPE_LABEL, formatSize, formatTime } from './backup-logic';
import { openBackupFolder } from '../services/engineApi';
import { NavIcon } from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useT } from '../i18n';

function BackupRecordRow({
  record,
  isExpanded,
  onToggle,
  onDelete,
}: {
  record: BackupRecordData;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { toast } = useToast();
  const info = STATUS_LABEL[record.status] ?? {
    textKey: record.status,
    color: 'rgb(var(--zh-muted))',
  };

  const openFolder = async (target: string): Promise<void> => {
    const ok = await openBackupFolder(target);
    if (!ok) toast(t('page.backup.toast.openFailed'), 'error');
  };
  // 行图标打开备份根目录（可见该项目全部历史快照）；详情内链接直达本次快照本身。
  const snapshot = record.localBackupPath ?? null;
  const backupRoot = snapshot ? snapshot.slice(0, snapshot.lastIndexOf('/')) || snapshot : null;
  return (
    <BounceCard className="rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zh-panel transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-4">
          <span className="w-2 h-2 rounded-full" style={{ background: info.color }} />
          <span className="text-sm font-mono text-zh-muted">{formatTime(record.timestamp)}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-zh-panel text-zh-muted">
            {t(TYPE_LABEL[record.type] ?? record.type)}
          </span>
          <span className="text-xs" style={{ color: info.color }}>
            {t(info.textKey)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zh-muted">{record.duration}ms</span>
          {backupRoot && (
            <Bounce
              as="button"
              title={t('page.backup.openFolderTip', { path: backupRoot })}
              aria-label={t('page.backup.openFolder')}
              onClick={(e) => {
                e.stopPropagation();
                void openFolder(backupRoot);
              }}
              className="flex items-center justify-center w-7 h-7 rounded hover:bg-brand/10 transition-colors text-zh-muted hover:text-zh-brand cursor-pointer border-none bg-transparent"
            >
              <NavIcon id="folder" size={16} />
            </Bounce>
          )}
          <Bounce
            as="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-xs border-none cursor-pointer px-2 py-1 rounded hover:bg-red-50 transition-colors text-red-500"
          >
            {t('common.delete')}
          </Bounce>
        </div>
      </div>
      {isExpanded && (
        <div className="px-4 pb-3 pt-1 text-xs bg-zh-panel text-zh-muted">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
            <div>{t('page.backup.detail.backupId', { id: record.id })}</div>
            <div>
              {t('page.backup.detail.trigger', {
                mode:
                  record.trigger === 'manual'
                    ? t('page.backup.trigger.manual')
                    : record.trigger === 'schedule'
                      ? t('page.backup.trigger.schedule')
                      : 'API',
              })}
            </div>
            {record.githubRepoUrl && (
              <div>
                {t('page.backup.detail.github')}
                <a href={record.githubRepoUrl} target="_blank" className="text-blue-500">
                  {record.githubRepoUrl}
                </a>
              </div>
            )}
            {record.githubCommitHash && (
              <div>
                {t('page.backup.detail.commit', { hash: record.githubCommitHash.slice(0, 7) })}
              </div>
            )}
            {snapshot && (
              <div className="flex items-center gap-2">
                <span>{t('page.backup.detail.localPath', { path: snapshot })}</span>
                <button
                  onClick={() => {
                    void openFolder(snapshot);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline cursor-pointer border-none bg-transparent"
                >
                  <NavIcon id="folder" size={14} />
                  {t('page.backup.openFolder')}
                </button>
              </div>
            )}
            {record.backupSize != null && (
              <div>{t('page.backup.detail.size', { size: formatSize(record.backupSize) })}</div>
            )}
            {record.fileCount != null && (
              <div>{t('page.backup.detail.fileCount', { count: record.fileCount })}</div>
            )}
            {record.error && (
              <div className="col-span-2 text-red-500">
                {t('page.backup.detail.error', { error: record.error })}
              </div>
            )}
          </div>
        </div>
      )}
    </BounceCard>
  );
}

export function BackupRecordsPanel({
  records,
  expandedId,
  onToggle,
  onDelete,
}: {
  records: BackupRecordData[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  return (
    <ResultCard variant="list">
      <div className="px-5 py-4 border-b border-zh-line">
        <h3 className="text-sm font-semibold text-zh-ink-2">
          {t('page.backup.recordsTitle')}
          <span className="ml-2 font-normal text-zh-muted">({records.length})</span>
        </h3>
      </div>
      {records.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-zh-muted">
          <p className="text-sm">{t('page.backup.noRecords')}</p>
        </div>
      ) : (
        <div className="p-3 space-y-1">
          {records.map((record) => (
            <BackupRecordRow
              key={record.id}
              record={record}
              isExpanded={expandedId === record.id}
              onToggle={() => onToggle(record.id)}
              onDelete={() => onDelete(record.id)}
            />
          ))}
        </div>
      )}
    </ResultCard>
  );
}
