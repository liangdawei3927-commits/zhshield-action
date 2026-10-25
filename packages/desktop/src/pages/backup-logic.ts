import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import {
  runBackup,
  cancelBackup,
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

/** 备份调度配置（定时备份的 cron 表达式与启用开关，取自 BackupConfigData.schedule） */
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

/** 拉取项目备份记录。必须传 projectPath：主进程 getRecords 无参时返回全部项目的记录，
 * 会把其他项目的快照列进本页并暴露在删除确认框里（进度推送已按 projectId 过滤，此处须一致） */
async function loadBackupRecords(
  projectPath: string,
  setRecords: Dispatch<SetStateAction<BackupRecordData[]>>,
): Promise<void> {
  try {
    const data = await getBackupRecords(projectPath);
    setRecords(data);
  } catch {
    /* ignore */
  }
}

/** 备份记录数据：列表状态 + 拉取 */
function useBackupRecordData(projectPath: string): {
  records: BackupRecordData[];
  setRecords: Dispatch<SetStateAction<BackupRecordData[]>>;
  fetchRecords: () => Promise<void>;
} {
  const [records, setRecords] = useState<BackupRecordData[]>([]);

  const fetchRecords = useCallback(
    () => loadBackupRecords(projectPath, setRecords),
    [projectPath],
  );

  return { records, setRecords, fetchRecords };
}

/** 备份记录加载：初始加载副作用 */
function useBackupRecords(projectPath: string): {
  records: BackupRecordData[];
  setRecords: Dispatch<SetStateAction<BackupRecordData[]>>;
  loadRecords: () => Promise<void>;
} {
  const { records, setRecords, fetchRecords } = useBackupRecordData(projectPath);

  useEffect(() => {
    void fetchRecords();
  }, [fetchRecords]);

  return { records, setRecords, loadRecords: fetchRecords };
}

/** 备份进度推送订阅：主进程 eventBus 实时推送（950MB 大包需 2-3 分钟，无进度时 UI 像死机；payload 可能来自其他项目的定时备份，按 projectId 过滤） */
function useBackupProgressState(
  projectPath: string,
): [BackupProgressData | null, Dispatch<SetStateAction<BackupProgressData | null>>] {
  const [progress, setProgress] = useState<BackupProgressData | null>(null);
  useEffect(
    () =>
      onBackupProgress((payload) => {
        if (payload && payload.projectId === projectPath) {
          setProgress(payload);
        }
      }),
    [projectPath],
  );
  return [progress, setProgress];
}

/** 一键备份执行：状态 + 进度推送 + 结果提示 + 停止 */
function useBackupRun(
  projectPath: string,
  loadRecords: () => Promise<void>,
): {
  isBackingUp: boolean;
  isStopping: boolean;
  progress: BackupProgressData | null;
  lastResult: BackupResultData | null;
  error: string | null;
  handleBackup: () => Promise<void>;
  handleStopBackup: () => Promise<void>;
} {
  const [isBackingUp, setIsBackingUp] = useState(false);
  /** 已发出停止、等主进程确认（按钮显示「停止中」并禁用，防连点） */
  const [isStopping, setIsStopping] = useState(false);
  const [progress, setProgress] = useBackupProgressState(projectPath);
  const [lastResult, setLastResult] = useState<BackupResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleBackup = useCallback(async () => {
    setIsBackingUp(true);
    setProgress(null);
    setError(null);
    setLastResult(null);
    try {
      const result = await runBackup(projectPath, 'manual');
      setLastResult(result);
      await loadRecords();
      if (result.overallStatus === 'cancelled') {
        // 用户主动停止 ≠ 失败：不落记录（kernel 已跳过），这里也不报 error
        toast(t('page.backup.toast.cancelled'), 'info');
        return;
      }
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
      setIsStopping(false);
      setProgress(null);
    }
  }, [projectPath, toast, loadRecords]);

  /**
   * 停止进行中的备份（用户诉求：点下去停不了）。
   *
   * kernel 会在最近的检查点停下：未写完的 zip / 清单不落盘，也不会记一条失败记录。
   * 目录格式下 <snapshot>/ 里可能留下部分已复制的文件（无清单，不会被当作一次有效
   * 备份），下次备份的轮换会清掉 —— 强删正在写的目录更危险，故不做。
   */
  const handleStopBackup = useCallback(async () => {
    // 不在这里清 isStopping：备份仍在收尾（kernel 走到下一个检查点才返回），
    // 由 handleBackup 的 finally 统一清。否则按钮会先恢复成「一键备份」，
    // 而这一次备份其实还没结束 —— 用户再点就是并发跑两个备份。
    setIsStopping(true);
    await cancelBackup(projectPath);
  }, [projectPath]);

  return { isBackingUp, isStopping, progress, lastResult, error, handleBackup, handleStopBackup };
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

/** 定时备份 schedule 状态：读取项目级配置 + 本地编辑（此前该配置无任何 UI 入口） */
function useScheduleState(projectPath: string): {
  schedule: BackupScheduleData | null;
  update: (patch: Partial<BackupScheduleData>) => void;
} {
  const [schedule, setSchedule] = useState<BackupScheduleData | null>(null);

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

  return { schedule, update };
}

/** 定时备份保存：合并完整配置写盘 + 结果提示 */
function useScheduleSaver(
  projectPath: string,
  schedule: BackupScheduleData | null,
): { saving: boolean; save: () => Promise<void> } {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

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

  return { saving, save };
}

/** 定时备份设置：读取/编辑/保存项目级 schedule 配置 */
export function useBackupSchedule(projectPath: string) {
  const { schedule, update } = useScheduleState(projectPath);
  const { saving, save } = useScheduleSaver(projectPath, schedule);

  return { schedule, update, save, saving };
}

/** 备份页全部状态与副作用：记录加载（含定时备份后台刷新）、一键备份+进度、删除确认 */
export function useBackupPage(projectPath: string) {
  const { records, setRecords, loadRecords } = useBackupRecords(projectPath);
  const { isBackingUp, isStopping, progress, lastResult, error, handleBackup, handleStopBackup } =
    useBackupRun(projectPath, loadRecords);
  const { deleteTarget, setDeleteTarget, handleDeleteConfirm } = useBackupDelete((id) =>
    setRecords((prev) => prev.filter((r) => r.id !== id)),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 定时备份在后台完成时刷新记录列表（用户停留在备份页也能看到新记录）
  useEffect(() => onBackupRecordsUpdated(() => void loadRecords()), [loadRecords]);

  return {
    records,
    isBackingUp,
    isStopping,
    progress,
    lastResult,
    expandedId,
    setExpandedId,
    error,
    deleteTarget,
    setDeleteTarget,
    handleBackup,
    handleStopBackup,
    handleDeleteConfirm,
  };
}
