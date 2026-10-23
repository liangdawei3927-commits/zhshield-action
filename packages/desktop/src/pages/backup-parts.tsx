import type { ReactNode } from 'react';
import type { BackupResultData, BackupProgressData } from '../types/electron';
import {
  STATUS_LABEL,
  TYPE_LABEL,
  formatTime,
  useBackupSchedule,
  type BackupScheduleData,
} from './backup-logic';
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

/** 定时备份已启用控件：频率 / 周几 / 每月几日 / 时间 / 保存 */
function ScheduleControls({
  schedule,
  saving,
  onUpdate,
  onSave,
  t,
}: {
  schedule: BackupScheduleData;
  saving: boolean;
  onUpdate: (patch: Partial<BackupScheduleData>) => void;
  onSave: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div className="ml-auto flex items-center flex-wrap gap-3 text-sm text-zh-ink">
      <select
        aria-label={t('page.backup.schedule.frequency')}
        value={schedule.frequency}
        onChange={(e) => onUpdate({ frequency: e.target.value })}
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
          onChange={(e) => onUpdate({ dayOfWeek: Number(e.target.value) })}
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
              onUpdate({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })
            }
            className="w-16 px-2 py-1.5 rounded-lg border border-black/10 bg-white"
          />
        </label>
      )}
      <input
        type="time"
        aria-label={t('page.backup.schedule.time')}
        value={schedule.time}
        onChange={(e) => onUpdate({ time: e.target.value })}
        className="px-2 py-1.5 rounded-lg border border-black/10 bg-white"
      />
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        style={{
          background: 'rgb(var(--zh-brand))',
          color: '#fff',
        }}
      >
        {t(saving ? 'page.backup.schedule.saving' : 'page.backup.schedule.save')}
      </button>
    </div>
  );
}

/** 定时备份卡片（单行）：图标 + 标题 + 状态徽章 + 评分 + 频率/时间/保存 + 启用开关 */
function ScheduleHeaderRow({
  enabled,
  score,
  onToggle,
  schedule,
  saving,
  onUpdate,
  onSave,
  t,
}: {
  enabled: boolean;
  score?: ReactNode;
  onToggle: () => void;
  schedule: BackupScheduleData | null;
  saving: boolean;
  onUpdate: (patch: Partial<BackupScheduleData>) => void;
  onSave: () => void;
  t: ReturnType<typeof useT>;
}) {
  const toggleBtn = (mlAuto: boolean) => (
    <button
      type="button"
      onClick={onToggle}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${mlAuto ? 'ml-auto' : ''}`}
      style={{
        borderColor: enabled ? 'rgb(var(--zh-muted) / 0.3)' : 'rgb(var(--zh-brand))',
        color: enabled ? 'rgb(var(--zh-muted))' : 'rgb(var(--zh-brand))',
      }}
    >
      {t(enabled ? 'page.backup.schedule.disable' : 'page.backup.schedule.enable')}
    </button>
  );

  return (
    <div className="flex items-center flex-wrap gap-3">
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
      {score}
      {enabled && schedule ? (
        <>
          <ScheduleControls
            schedule={schedule}
            saving={saving}
            onUpdate={onUpdate}
            onSave={onSave}
            t={t}
          />
          {toggleBtn(false)}
        </>
      ) : (
        toggleBtn(true)
      )}
    </div>
  );
}

/** 定时备份设置区块（无独立卡片容器，嵌入备份记录卡片头部）：单行开关/频率/时间/保存 */
export function BackupScheduleRow({
  projectPath,
  score,
}: {
  projectPath: string;
  score?: ReactNode;
}) {
  const t = useT();
  const { schedule, update, save, saving } = useBackupSchedule(projectPath);
  const enabled = schedule?.enabled === true;

  return (
    <>
      <ScheduleHeaderRow
        enabled={enabled}
        score={score}
        schedule={schedule}
        saving={saving}
        onToggle={() => update({ enabled: !enabled })}
        onUpdate={update}
        onSave={() => void save()}
        t={t}
      />
      {!enabled && <p className="mt-2 text-xs text-zh-muted">{t('page.backup.schedule.descOff')}</p>}
    </>
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
      <div className="h-1.5 rounded-full bg-zh-line overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-brand-600 to-brand-800"
          style={{
            width: `${Math.min(100, Math.max(0, progress.percent))}%`,
          }}
        />
      </div>
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
