import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import {
  runBackup,
  getBackupRecords,
  deleteBackupRecord,
  getBackupConfig,
  saveBackupConfig,
  onBackupProgress,
  onBackupRecordsUpdated,
} from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import type {
  BackupRecordData,
  BackupResultData,
  BackupProgressData,
  BackupConfigData,
} from '../types/electron';

export type BackupScheduleData = BackupConfigData['schedule'];

export const STATUS_LABEL: Record<string, { textKey: string; color: string }> = {
  success: { textKey: 'page.backup.status.success', color: 'rgb(var(--zh-success))' },
  partial: { textKey: 'page.backup.status.partial', color: 'rgb(var(--zh-warning))' },
  failed: { textKey: 'page.backup.status.failed', color: 'rgb(var(--zh-danger))' },
};

export const TYPE_LABEL: Record<string, string> = {
  full: 'page.backup.type.full',
  'github-only': 'page.backup.type.githubOnly',
  'local-only': 'page.backup.type.localOnly',
};

export function formatSize(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

/** 备份记录数据：列表状态 + 拉取 */
function useBackupRecordData(): {
  records: BackupRecordData[];
  setRecords: Dispatch<SetStateAction<BackupRecordData[]>>;
  fetchRecords: () => Promise<void>;
} {
  const [records, setRecords] = useState<BackupRecordData[]>([]);

  const fetchRecords = useCallback(async () => {
    try {
      const data = await getBackupRecords();
      setRecords(data);
    } catch {
      /* ignore */
    }
  }, []);

  return { records, setRecords, fetchRecords };
}

/** 备份记录加载：初始加载副作用 */
function useBackupRecords(): {
  records: BackupRecordData[];
  setRecords: Dispatch<SetStateAction<BackupRecordData[]>>;
  loadRecords: () => Promise<void>;
} {
  const { records, setRecords, fetchRecords } = useBackupRecordData();

  useEffect(() => {
    void fetchRecords();
  }, [fetchRecords]);

  return { records, setRecords, loadRecords: fetchRecords };
}

/** 一键备份执行：状态 + 进度推送 + 结果提示 */
function useBackupRun(
  projectPath: string,
  loadRecords: () => Promise<void>,
): {
  isBackingUp: boolean;
  progress: BackupProgressData | null;
  lastResult: BackupResultData | null;
  error: string | null;
  handleBackup: () => Promise<void>;
} {
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [progress, setProgress] = useState<BackupProgressData | null>(null);
  const [lastResult, setLastResult] = useState<BackupResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  // 订阅主进程推送的备份进度（950MB 大包需 2-3 分钟，无进度时 UI 像死机）
  // 注意 payload 可能来自其他项目的定时备份，按 projectId 过滤
  useEffect(
    () =>
      onBackupProgress((payload) => {
        if (payload && payload.projectId === projectPath) {
          setProgress(payload);
        }
      }),
    [projectPath],
  );

  const handleBackup = useCallback(async () => {
    setIsBackingUp(true);
    setProgress(null);
    setError(null);
    setLastResult(null);
    try {
      const result = await runBackup(projectPath, 'manual');
      setLastResult(result);
      await loadRecords();
      toast(
        result.overallStatus === 'success'
          ? t('page.backup.toast.success')
          : t('page.backup.toast.completed', { status: result.overallStatus }),
        result.overallStatus === 'failed' ? 'error' : 'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('page.backup.toast.failed');
      setError(msg);
      toast(msg, 'error');
    } finally {
      setIsBackingUp(false);
      setProgress(null);
    }
  }, [projectPath, toast, loadRecords]);

  return { isBackingUp, progress, lastResult, error, handleBackup };
}

/** 删除确认：目标状态 + 确认执行 */
function useBackupDelete(onDeleted: (id: string) => void): {
  deleteTarget: string | null;
  setDeleteTarget: Dispatch<SetStateAction<string | null>>;
  handleDeleteConfirm: () => Promise<void>;
} {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const { toast } = useToast();

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const ok = await deleteBackupRecord(deleteTarget);
    if (ok) {
      onDeleted(deleteTarget);
      toast(t('page.backup.toast.deleted'), 'success');
    } else {
      toast(t('page.backup.toast.deleteFailed'), 'error');
    }
    setDeleteTarget(null);
  }, [deleteTarget, toast, onDeleted]);

  return { deleteTarget, setDeleteTarget, handleDeleteConfirm };
}

/** 定时备份设置：读取/编辑/保存项目级 schedule 配置（此前该配置无任何 UI 入口） */
export function useBackupSchedule(projectPath: string) {
  const [schedule, setSchedule] = useState<BackupScheduleData | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let active = true;
    getBackupConfig(projectPath)
      .then((c) => {
        if (active)
          setSchedule(c?.schedule ?? { enabled: false, frequency: 'daily', time: '02:00' });
      })
      .catch(() => {
        if (active) setSchedule({ enabled: false, frequency: 'daily', time: '02:00' });
      });
    return () => {
      active = false;
    };
  }, [projectPath]);

  const update = useCallback((patch: Partial<BackupScheduleData>) => {
    setSchedule((prev) => ({
      enabled: false,
      frequency: 'daily',
      time: '02:00',
      ...prev,
      ...patch,
    }));
  }, []);

  const save = useCallback(async () => {
    if (!schedule) return;
    setSaving(true);
    try {
      const full = await getBackupConfig(projectPath);
      if (!full) throw new Error('backup config unavailable');
      await saveBackupConfig(projectPath, { ...full, schedule });
      toast(t('page.backup.schedule.saved'), 'success');
    } catch {
      toast(t('page.backup.schedule.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }, [projectPath, schedule, toast]);

  return { schedule, update, save, saving };
}

/** 备份页全部状态与副作用：记录加载（含定时备份后台刷新）、一键备份+进度、删除确认 */
export function useBackupPage(projectPath: string) {
  const { records, setRecords, loadRecords } = useBackupRecords();
  const { isBackingUp, progress, lastResult, error, handleBackup } = useBackupRun(
    projectPath,
    loadRecords,
  );
  const { deleteTarget, setDeleteTarget, handleDeleteConfirm } = useBackupDelete((id) =>
    setRecords((prev) => prev.filter((r) => r.id !== id)),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 定时备份在后台完成时刷新记录列表（用户停留在备份页也能看到新记录）
  useEffect(() => onBackupRecordsUpdated(() => void loadRecords()), [loadRecords]);

  return {
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
  };
}
