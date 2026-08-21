import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import { runSecurity, cleanGarbage, restoreGarbage } from '../services/engineApi';
import type { SecurityScanReportData, GarbageCleanResultData, GarbageRestoreResultData } from '../types/electron';
import { useTaskRun } from '../task-store';

const CLEANABLE_TYPE = 'unused-file';

/** 勾选状态：维护选中集合，支持单选切换、全选/取消全选 */
function useGarbageSelection(report: SecurityScanReportData | null): {
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
} {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!report) return;
    setSelected((prev) => {
      const cleanable = report.garbage.filter((g) => g.type === CLEANABLE_TYPE).map((g) => g.id);
      const allChecked = cleanable.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of cleanable) {
        if (allChecked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [report]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  return { selected, toggleSelect, toggleAll, clearSelection };
}

/** 清理/恢复动作：调用引擎执行清理与回收站恢复，维护执行中状态与结果横幅 */
function useGarbageActions(params: {
  projectPath: string;
  report: SecurityScanReportData | null;
  selected: Set<string>;
  onReportChange: Dispatch<SetStateAction<SecurityScanReportData | null>>;
  onSelectionCleared: () => void;
  onRefresh: () => Promise<void>;
}): {
  cleaning: boolean;
  restoring: boolean;
  cleanResult: GarbageCleanResultData | null;
  restoreResult: GarbageRestoreResultData | null;
  handleClean: () => Promise<void>;
  handleRestore: () => Promise<void>;
  clearResults: (clearRestore: boolean) => void;
} {
  const { projectPath, report, selected, onReportChange, onSelectionCleared, onRefresh } = params;
  const [cleaning, setCleaning] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [cleanResult, setCleanResult] = useState<GarbageCleanResultData | null>(null);
  const [restoreResult, setRestoreResult] = useState<GarbageRestoreResultData | null>(null);

  const handleClean = useCallback(async () => {
    if (!report || selected.size === 0) return;
    const items = report.garbage.filter((g) => selected.has(g.id));
    setCleaning(true);
    try {
      const result = await cleanGarbage(projectPath, items);
      setCleanResult(result);
      const cleanedIds = new Set(result.cleaned.map((c) => c.id));
      onReportChange((prev) =>
        prev ? { ...prev, garbage: prev.garbage.filter((g) => !cleanedIds.has(g.id)) } : prev,
      );
      onSelectionCleared();
    } catch {
      setCleanResult({ batchId: '', cleaned: [], freedBytes: 0, failed: [t('page.garbage.cleanFailed')] });
    } finally {
      setCleaning(false);
    }
  }, [projectPath, report, selected, onReportChange, onSelectionCleared]);

  const handleRestore = useCallback(async () => {
    if (!cleanResult?.batchId) return;
    setRestoring(true);
    try {
      const result = await restoreGarbage(projectPath, cleanResult.batchId);
      setRestoreResult(result);
      setCleanResult(null);
      await onRefresh();
    } catch {
      setRestoreResult({ restored: 0, restoredBytes: 0, failed: [t('page.garbage.restoreFailed')] });
    } finally {
      setRestoring(false);
    }
  }, [projectPath, cleanResult, onRefresh]);

  /** 清空结果横幅：清理结果始终清空，恢复结果仅在 clearRestore=true 时清空 */
  const clearResults = useCallback((clearRestore: boolean) => {
    setCleanResult(null);
    if (clearRestore) setRestoreResult(null);
  }, []);

  return {
    cleaning,
    restoring,
    cleanResult,
    restoreResult,
    handleClean,
    handleRestore,
    clearResults,
  };
}

/** 垃圾清理页：复用安全引擎一次全扫，页面只取 garbage 字段展示；支持勾选清理与回收站恢复 */
export function useGarbagePage(projectPath: string): {
  loading: boolean;
  progressLabel: string;
  report: SecurityScanReportData | null;
  selected: Set<string>;
  cleaning: boolean;
  restoring: boolean;
  cleanResult: GarbageCleanResultData | null;
  restoreResult: GarbageRestoreResultData | null;
  handleScan: () => Promise<void>;
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  handleClean: () => Promise<void>;
  handleRestore: () => Promise<void>;
} {
  const [report, setReport] = useState<SecurityScanReportData | null>(null);
  const { loading, progressLabel } = useTaskRun('security', projectPath);

  const { selected, toggleSelect, toggleAll, clearSelection } = useGarbageSelection(report);

  /** 仅刷新扫描结果与勾选状态，不触碰结果横幅（恢复成功后复用） */
  const refreshReport = useCallback(async () => {
    try {
      const result = await runSecurity(projectPath);
      setReport(result);
      clearSelection();
    } catch {
      setReport(null);
    }
  }, [projectPath, clearSelection]);

  const {
    cleaning,
    restoring,
    cleanResult,
    restoreResult,
    handleClean,
    handleRestore,
    clearResults,
  } = useGarbageActions({
    projectPath,
    report,
    selected,
    onReportChange: setReport,
    onSelectionCleared: clearSelection,
    onRefresh: refreshReport,
  });

  /** 重新扫描并刷新清单；keepBanner=true 时保留恢复结果横幅（恢复后刷新场景） */
  const handleScan = useCallback(async (keepBanner = false) => {
    clearResults(!keepBanner);
    await refreshReport();
  }, [refreshReport, clearResults]);

  return {
    loading,
    progressLabel,
    report,
    selected,
    cleaning,
    restoring,
    cleanResult,
    restoreResult,
    handleScan,
    toggleSelect,
    toggleAll,
    handleClean,
    handleRestore,
  };
}
