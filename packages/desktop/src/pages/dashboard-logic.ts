import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { getDashboardOverview, runFullCheck } from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import type { ToastVariant } from '../components/ui/toast-logic';
import type { DashboardOverview, PipelineProgress } from '../types/electron';
import { useTask, useTasks } from '../task-store';

const REFACTOR_KEYWORD = /重构/;

export function sanitizeProgress(message?: string, stage?: string): string {
  if (stage === 'sop') return t('page.dashboard.sanitize.loadingRules');
  if (stage === 'guard')
    return message?.includes('未通过') ? message : t('page.dashboard.sanitize.guarding');
  if (stage === 'inspect') return t('page.dashboard.sanitize.inspecting');
  if (stage === 'autofix') return message || t('page.dashboard.sanitize.autoFixing');
  if (stage === 'done')
    return message && !REFACTOR_KEYWORD.test(message) ? message : t('page.dashboard.sanitize.done');
  if (!message || REFACTOR_KEYWORD.test(message)) return t('page.dashboard.running');
  return message;
}

/** 一键全检进度订阅：进度来自统一任务中心（tasks:changed），autofix 通知独立保留 */
export function usePipelineProgress(projectPath: string) {
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
  const [autoFixNotice, setAutoFixNotice] = useState<string | null>(null);
  const task = useTask('pipeline', projectPath);

  useEffect(() => {
    if (task && (task.status === 'queued' || task.status === 'running')) {
      const message =
        task.message && REFACTOR_KEYWORD.test(task.message)
          ? sanitizeProgress(task.message, task.stage)
          : (task.message ?? '');
      setPipelineProgress({ stage: task.stage ?? 'running', message, progress: task.progress });
    } else if (
      task &&
      (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
    ) {
      setPipelineProgress(null);
    }
  }, [task]);

  useEffect(() => {
    const unsub = window.electronAPI?.onPipelineProgress?.((p) => {
      if (p?.stage === 'autofix') {
        setAutoFixNotice(p.message || t('page.dashboard.sanitize.autoFixStarted'));
        return;
      }
    });
    return () => unsub?.();
  }, []);

  return { pipelineProgress, autoFixNotice, setPipelineProgress, setAutoFixNotice };
}

/** 聚合仪表盘数据：调 engineApi.getDashboardOverview；任务中心变化（含全检完成）时自动刷新 */
export function useDashboardOverview(projectPath: string) {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const tasks = useTasks();

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setOverview(null);
      return;
    }
    setLoading(true);
    try {
      const data = await getDashboardOverview(projectPath);
      setOverview(data);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh, tasks]);

  return { overview, loading, refresh };
}

/** 一键全检执行：调 engineApi.runFullCheck；force=true 为强制全量重跑（需显式确认） */
export function useOneClickCheck(
  projectPath: string,
  toast: (msg: string, variant?: ToastVariant) => void,
  setPipelineProgress: (p: PipelineProgress | null) => void,
  setAutoFixNotice: (n: string | null) => void,
) {
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async (force: boolean) => {
      if (!projectPath) {
        toast(t('page.dashboard.toast.addProjectFirst'), 'warning');
        return;
      }
      setRunning(true);
      setPipelineProgress({
        stage: 'sop',
        message: t('page.dashboard.sanitize.loadingRules'),
        progress: 0.05,
      });
      setAutoFixNotice(null);
      try {
        const result = await runFullCheck(projectPath, { force });
        if (!result.ok) {
          toast(result.error || t('page.dashboard.toast.executionFailed'), 'error');
        } else if (result.reran.length === 0) {
          toast(t('page.dashboard.toast.allFresh'), 'info');
        } else {
          toast(t('page.dashboard.toast.fullCheckDone', { count: result.reran.length }), 'success');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('page.dashboard.toast.executionFailed');
        toast(msg, 'error');
      } finally {
        setRunning(false);
        setPipelineProgress(null);
      }
    },
    [projectPath, toast, setPipelineProgress, setAutoFixNotice],
  );

  const handleOneClickCheck = useCallback(() => run(false), [run]);
  const handleForceFullCheck = useCallback(() => run(true), [run]);

  return { running, handleOneClickCheck, handleForceFullCheck };
}

/** 体检页全部状态与副作用：聚合总览加载、一键全检（含强制全量）、进度监听 */
export function useDashboardPage(projectPath: string) {
  const { toast } = useToast();
  const {
    overview,
    loading: overviewLoading,
    refresh: refreshOverview,
  } = useDashboardOverview(projectPath);
  const { pipelineProgress, autoFixNotice, setPipelineProgress, setAutoFixNotice } =
    usePipelineProgress(projectPath);
  const { running, handleOneClickCheck, handleForceFullCheck } = useOneClickCheck(
    projectPath,
    toast,
    setPipelineProgress,
    setAutoFixNotice,
  );

  const handleOneClickCheckAndRefresh = useCallback(async () => {
    await handleOneClickCheck();
    refreshOverview();
  }, [handleOneClickCheck, refreshOverview]);

  const handleForceFullCheckAndRefresh = useCallback(async () => {
    await handleForceFullCheck();
    refreshOverview();
  }, [handleForceFullCheck, refreshOverview]);

  const progressLabel = sanitizeProgress(pipelineProgress?.message, pipelineProgress?.stage);

  return {
    overview,
    overviewLoading,
    running,
    progressLabel,
    pipelineProgress,
    autoFixNotice,
    handleOneClickCheck: handleOneClickCheckAndRefresh,
    handleForceFullCheck: handleForceFullCheckAndRefresh,
  };
}
