import type { BackupRecordData, BackupResultData, BackupProgressData } from '../types/electron';
import {
  STATUS_LABEL,
  TYPE_LABEL,
  formatTime,
  useBackupSchedule,
  type BackupScheduleData,
} from './backup-logic';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { BackupRecordsPanel } from './backup-records';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

const WEEKDAY_KEYS = [
  'page.backup.schedule.weekday.0',
  'page.backup.schedule.weekday.1',
  'page.backup.schedule.weekday.2',
  'page.backup.schedule.weekday.3',
  'page.backup.schedule.weekday.4',
  'page.backup.schedule.weekday.5',
  'page.backup.schedule.weekday.6',
] as const;

/** 定时备份设置卡片：启用开关 + 频率/时间选择 + 保存（保存后调度器即时生效） */
export function BackupScheduleCard({ projectPath }: { projectPath: string }) {
  const t = useT();
  const { schedule, update, save, saving } = useBackupSchedule(projectPath);
  const enabled = schedule?.enabled === true;

  const freqLabel = (f: BackupScheduleData['frequency']) =>
    f === 'weekly'
      ? t('page.backup.schedule.freqWeekly')
      : f === 'monthly'
        ? t('page.backup.schedule.freqMonthly')
        : t('page.backup.schedule.freqDaily');

  return (
    <div className="mb-8 px-5 py-4 rounded-xl bg-white border border-black/5 shadow-sm">
      <div className="flex items-center gap-3">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(var(--zh-brand))"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
        <span className="text-sm font-semibold text-zh-ink">{t('page.backup.schedule.title')}</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: enabled ? 'rgb(var(--zh-success) / 0.1)' : 'rgb(var(--zh-muted) / 0.1)',
            color: enabled ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-muted))',
          }}
        >
          {t(enabled ? 'page.backup.schedule.enabled' : 'page.backup.schedule.disabled')}
        </span>
        <button
          type="button"
          onClick={() => update({ enabled: !enabled })}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg border transition-colors"
          style={{
            borderColor: enabled ? 'rgb(var(--zh-muted) / 0.3)' : 'rgb(var(--zh-brand))',
            color: enabled ? 'rgb(var(--zh-muted))' : 'rgb(var(--zh-brand))',
          }}
        >
          {t(enabled ? 'page.backup.schedule.disable' : 'page.backup.schedule.enable')}
        </button>
      </div>

      {schedule && enabled && (
        <div className="flex items-center flex-wrap gap-3 mt-3 text-sm text-zh-ink">
          <select
            aria-label={t('page.backup.schedule.frequency')}
            value={schedule.frequency}
            onChange={(e) => update({ frequency: e.target.value })}
            className="px-2 py-1.5 rounded-lg border border-black/10 bg-white"
          >
            <option value="daily">{t('page.backup.schedule.freqDaily')}</option>
            <option value="weekly">{t('page.backup.schedule.freqWeekly')}</option>
            <option value="monthly">{t('page.backup.schedule.freqMonthly')}</option>
          </select>

          {schedule.frequency === 'weekly' && (
            <select
              aria-label={t('page.backup.schedule.dayOfWeek')}
              value={String(schedule.dayOfWeek ?? 0)}
              onChange={(e) => update({ dayOfWeek: Number(e.target.value) })}
              className="px-2 py-1.5 rounded-lg border border-black/10 bg-white"
            >
              {WEEKDAY_KEYS.map((key, idx) => (
                <option key={idx} value={idx}>
                  {t(key)}
                </option>
              ))}
            </select>
          )}

          {schedule.frequency === 'monthly' && (
            <label className="flex items-center gap-1.5">
              <span className="text-zh-muted">{t('page.backup.schedule.dayOfMonth')}</span>
              <input
                type="number"
                min={1}
                max={28}
                value={schedule.dayOfMonth ?? 1}
                onChange={(e) =>
                  update({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })
                }
                className="w-16 px-2 py-1.5 rounded-lg border border-black/10 bg-white"
              />
            </label>
          )}

          <input
            type="time"
            aria-label={t('page.backup.schedule.time')}
            value={schedule.time}
            onChange={(e) => update({ time: e.target.value })}
            className="px-2 py-1.5 rounded-lg border border-black/10 bg-white"
          />

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            style={{
              background: 'rgb(var(--zh-brand))',
              color: '#fff',
            }}
          >
            {t(saving ? 'page.backup.schedule.saving' : 'page.backup.schedule.save')}
          </button>
        </div>
      )}

      <p className="mt-2 text-xs text-zh-muted">
        {enabled
          ? t('page.backup.schedule.descOn', {
              freq: freqLabel(schedule?.frequency ?? 'daily'),
              time: schedule?.time ?? '',
            })
          : t('page.backup.schedule.descOff')}
      </p>
    </div>
  );
}

/** 备份进行中进度条：主进程 eventBus 实时推送（无进度事件时显示不确定态提示） */
export function BackupProgressBar({ progress }: { progress: BackupProgressData | null }) {
  const t = useT();
  if (!progress) {
    return (
      <div className="mb-6 px-4 py-3 rounded-xl bg-brand-50 text-sm text-zh-muted">
        {t('page.backup.progressPreparing')}
      </div>
    );
  }
  return (
    <div className="mb-6 px-4 py-3 rounded-xl bg-brand-50">
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="text-zh-ink">{progress.message}</span>
        <span className="text-zh-muted tabular-nums">{progress.percent}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-brand-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(100, Math.max(0, progress.percent))}%`,
            background: 'rgb(var(--zh-brand))',
          }}
        />
      </div>
    </div>
  );
}

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
  progress: BackupProgressData | null;
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

/** 记录态：头部 + 进行中进度 + 最近结果 + 记录列表 + 删除确认 */
export function BackupRecordsView({
  records,
  isBackingUp,
  progress,
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
      <div className="w-full px-8 pb-10 pt-2">
        <BackupHeader recordCount={records.length} isBackingUp={isBackingUp} onBackup={onBackup} />

        {isBackingUp && <BackupProgressBar progress={progress} />}

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
