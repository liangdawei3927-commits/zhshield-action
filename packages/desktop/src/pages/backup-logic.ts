import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import { runBackup, getBackupRecords, deleteBackupRecord } from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import type { BackupRecordData, BackupResultData } from '../types/electron';

export const STATUS_LABEL: Record<string, { textKey: string; color: string }> = {
  success: { textKey: 'page.backup.status.success', color: 'rgb(var(--zh-success))' },
  partial: { textKey: 'page.backup.status.partial', color: 'rgb(var(--zh-warning))' },
  failed: { textKey: 'page.backup.status.failed', color: 'rgb(var(--zh-danger))' },
};

export const TYPE_LABEL: Record<string, string> = {
  full: 'page.backup.type.full', 'github-only': 'page.backup.type.githubOnly', 'local-only': 'page.backup.type.localOnly',
};

export function formatSize(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString('zh-CN'); } catch { return iso; }
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
    } catch { /* ignore */ }
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

  useEffect(() => { void fetchRecords(); }, [fetchRecords]);

  return { records, setRecords, loadRecords: fetchRecords };
}

/** 一键备份执行：状态 + 结果提示 */
function useBackupRun(
  projectPath: string,
  loadRecords: () => Promise<void>,
): {
  isBackingUp: boolean;
  lastResult: BackupResultData | null;
  error: string | null;
  handleBackup: () => Promise<void>;
} {
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [lastResult, setLastResult] = useState<BackupResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleBackup = useCallback(async () => {
    setIsBackingUp(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await runBackup(projectPath, 'manual');
      setLastResult(result);
      await loadRecords();
      toast(
        result.overallStatus === 'success' ? t('page.backup.toast.success') : t('page.backup.toast.completed', { status: result.overallStatus }),
        result.overallStatus === 'failed' ? 'error' : 'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('page.backup.toast.failed');
      setError(msg);
      toast(msg, 'error');
    } finally {
      setIsBackingUp(false);
    }
  }, [projectPath, toast, loadRecords]);

  return { isBackingUp, lastResult, error, handleBackup };
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

/** 备份页全部状态与副作用：记录加载、一键备份、删除确认 */
export function useBackupPage(projectPath: string) {
  const { records, setRecords, loadRecords } = useBackupRecords();
  const { isBackingUp, lastResult, error, handleBackup } = useBackupRun(projectPath, loadRecords);
  const { deleteTarget, setDeleteTarget, handleDeleteConfirm } = useBackupDelete(
    (id) => setRecords((prev) => prev.filter((r) => r.id !== id)),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return {
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
  };
}
