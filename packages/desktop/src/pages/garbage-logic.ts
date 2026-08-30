import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import { runSecurity, cleanGarbage, restoreGarbage } from '../services/engineApi';
import type { SecurityScanReportData, GarbageCleanResultData, GarbageRestoreResultData } from '../types/electron';
import { useTaskRun } from '../task-store';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';

/**
 * 引擎可移入回收站的垃圾类型（与 @zh/security garbage-scanner 的 cleanGarbage 能力对齐）：
 * unused-dependency 需通过包管理器移除，引擎不会物理移动，故不在可勾选集合内。
 */
export const CLEANABLE_TYPES: ReadonlySet<string> = new Set(['unused-file', 'dead-code', 'duplicate-code']);

export function isCleanableType(type: string): boolean {
  return CLEANABLE_TYPES.has(type);
}

function toggleIdInSet(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function toggleAllSelection(report: SecurityScanReportData, prev: Set<string>): Set<string> {
  const cleanable = report.garbage.filter((g) => isCleanableType(g.type)).map((g) => g.id);
  const allChecked = cleanable.length > 0 && cleanable.every((id) => prev.has(id));
  const next = new Set(prev);
  for (const id of cleanable) {
    if (allChecked) next.delete(id);
    else next.add(id);
  }
  return next;
}

function useSelectionHandlers(
  report: SecurityScanReportData | null,
  setSelected: Dispatch<SetStateAction<Set<string>>>,
): {
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
} {
  const toggleSelect = useCallback((id: string) => setSelected((prev) => toggleIdInSet(prev, id)), [setSelected]);
  const toggleAll = useCallback(() => {
    if (!report) return;
    setSelected((prev) => toggleAllSelection(report, prev));
  }, [report, setSelected]);
  const clearSelection = useCallback(() => setSelected(new Set()), [setSelected]);
  return { toggleSelect, toggleAll, clearSelection };
}

/** 勾选状态：维护选中集合，支持单选切换、全选/取消全选 */
function useGarbageSelection(report: SecurityScanReportData | null): {
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
} {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { toggleSelect, toggleAll, clearSelection } = useSelectionHandlers(report, setSelected);
  return { selected, toggleSelect, toggleAll, clearSelection };
}

interface CleanSetters {
  setCleaning: Dispatch<SetStateAction<boolean>>;
  setCleanResult: Dispatch<SetStateAction<GarbageCleanResultData | null>>;
  onReportChange: Dispatch<SetStateAction<SecurityScanReportData | null>>;
  onSelectionCleared: () => void;
}

async function performClean(projectPath: string, items: SecurityScanReportData['garbage'], setters: CleanSetters): Promise<void> {
  setters.setCleaning(true);
  try {
    const result = await cleanGarbage(projectPath, items);
    setters.setCleanResult(result);
    const cleanedIds = new Set(result.cleaned.map((c) => c.id));
    setters.onReportChange((prev) =>
      prev ? { ...prev, garbage: prev.garbage.filter((g) => !cleanedIds.has(g.id)) } : prev,
    );
    setters.onSelectionCleared();
  } catch {
    setters.setCleanResult({ batchId: '', cleaned: [], freedBytes: 0, failed: [t('page.garbage.cleanFailed')] });
  } finally {
    setters.setCleaning(false);
  }
}

interface RestoreSetters {
  setRestoring: Dispatch<SetStateAction<boolean>>;
  setRestoreResult: Dispatch<SetStateAction<GarbageRestoreResultData | null>>;
  onRestored: () => void;
  onRefresh: () => Promise<void>;
}

async function performRestore(projectPath: string, batchId: string, setters: RestoreSetters): Promise<void> {
  setters.setRestoring(true);
  try {
    const result = await restoreGarbage(projectPath, batchId);
    setters.setRestoreResult(result);
    setters.onRestored();
    await setters.onRefresh();
  } catch {
    setters.setRestoreResult({ restored: 0, restoredBytes: 0, failed: [t('page.garbage.restoreFailed')] });
  } finally {
    setters.setRestoring(false);
  }
}

function clearGarbageResults(
  setCleanResult: Dispatch<SetStateAction<GarbageCleanResultData | null>>,
  setRestoreResult: Dispatch<SetStateAction<GarbageRestoreResultData | null>>,
  clearRestore: boolean,
): void {
  setCleanResult(null);
  if (clearRestore) setRestoreResult(null);
}

function useGarbageClean(
  projectPath: string,
  report: SecurityScanReportData | null,
  selected: Set<string>,
  onReportChange: Dispatch<SetStateAction<SecurityScanReportData | null>>,
  onSelectionCleared: () => void,
): {
  cleaning: boolean;
  cleanResult: GarbageCleanResultData | null;
  handleClean: () => Promise<void>;
  setCleanResult: Dispatch<SetStateAction<GarbageCleanResultData | null>>;
} {
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<GarbageCleanResultData | null>(null);
  const handleClean = useCallback(async () => {
    if (!report || selected.size === 0) return;
    const items = report.garbage.filter((g) => selected.has(g.id));
    await performClean(projectPath, items, { setCleaning, setCleanResult, onReportChange, onSelectionCleared });
  }, [projectPath, report, selected, onReportChange, onSelectionCleared]);
  return { cleaning, cleanResult, handleClean, setCleanResult };
}

function useGarbageRestore(
  projectPath: string,
  cleanResult: GarbageCleanResultData | null,
  onRefresh: () => Promise<void>,
  onRestored: () => void,
): {
  restoring: boolean;
  restoreResult: GarbageRestoreResultData | null;
  handleRestore: () => Promise<void>;
  setRestoreResult: Dispatch<SetStateAction<GarbageRestoreResultData | null>>;
} {
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<GarbageRestoreResultData | null>(null);
  const handleRestore = useCallback(async () => {
    if (!cleanResult?.batchId) return;
    await performRestore(projectPath, cleanResult.batchId, { setRestoring, setRestoreResult, onRestored, onRefresh });
  }, [projectPath, cleanResult, onRestored, onRefresh]);
  return { restoring, restoreResult, handleRestore, setRestoreResult };
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
  const { cleaning, cleanResult, handleClean, setCleanResult } = useGarbageClean(projectPath, report, selected, onReportChange, onSelectionCleared);
  const { restoring, restoreResult, handleRestore, setRestoreResult } = useGarbageRestore(projectPath, cleanResult, onRefresh, () => setCleanResult(null));
  const clearResults = useCallback((clearRestore: boolean) => {
    clearGarbageResults(setCleanResult, setRestoreResult, clearRestore);
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

/** 全量复制垃圾清单到 AI 检查：删除前审阅，避免误删 */
function useGarbageCopyToAi(projectPath: string): {
  copyAllToAi: (items: SecurityScanReportData['garbage']) => void;
} {
  const { toast } = useToast();

  const runCopy = useCallback(
    (issues: AiFixIssue[]) => {
      const text = buildAiFixPrompt(projectPath, issues);
      void copyTextToClipboard(text).then(
        (ok) => (ok ? toast(t('page.garbage.copiedAll')) : toast(t('toast.copyFailed'), 'error')),
        () => toast(t('toast.copyFailed'), 'error'),
      );
    },
    [projectPath, toast],
  );

  const copyAllToAi = useCallback(
    (items: SecurityScanReportData['garbage']) => {
      if (items.length === 0) return;
      runCopy(
        items.map((g) => ({
          source: t('page.garbage.source'),
          ruleId: g.type,
          file: g.path,
          severity: isCleanableType(g.type) ? t('page.garbage.cleanableLabel') : t('page.garbage.manualLabel'),
          message: g.reason || g.path,
          suggestion: t('page.garbage.safetySuggestion'),
        })),
      );
    },
    [runCopy],
  );

  return { copyAllToAi };
}

async function refreshSecurityReport(
  projectPath: string,
  setReport: Dispatch<SetStateAction<SecurityScanReportData | null>>,
  clearSelection: () => void,
): Promise<void> {
  try {
    const result = await runSecurity(projectPath);
    setReport(result);
    clearSelection();
  } catch {
    setReport(null);
  }
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
  copyAllToAi: (items: SecurityScanReportData['garbage']) => void;
} {
  const [report, setReport] = useState<SecurityScanReportData | null>(null);
  const { loading, progressLabel } = useTaskRun('security', projectPath);
  const { selected, toggleSelect, toggleAll, clearSelection } = useGarbageSelection(report);
  const refreshReport = useCallback(
    () => refreshSecurityReport(projectPath, setReport, clearSelection),
    [projectPath, clearSelection],
  );
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
  const handleScan = useCallback(async (keepBanner = false) => {
    clearResults(!keepBanner);
    await refreshReport();
  }, [refreshReport, clearResults]);
  const { copyAllToAi } = useGarbageCopyToAi(projectPath);

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
    copyAllToAi,
  };
}
