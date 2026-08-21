import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { getScore, runPipeline } from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import type { ToastVariant } from '../components/ui/toast-logic';
import { buildAiFixPrompt, copyTextToClipboard } from '../utils/copyToAi';
import type { PipelineProgress, PipelineReportData } from '../types/electron';
import { useTask } from '../task-store';

/** 一键体检覆盖范围（给客户看的说明，不含重构、门禁、哨兵） */
export const CHECK_SCOPE = [
  {
    key: 'inspect',
    titleKey: 'page.dashboard.scope.inspect',
    items: [
      'page.dashboard.scope.item.tsType',
      'page.dashboard.scope.item.complexity',
      'page.dashboard.scope.item.deps',
      'page.dashboard.scope.item.nest',
      'page.dashboard.scope.item.docs',
    ],
  },
] as const;

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  failedItems: Array<{ stage: string; id: string; name: string; message: string }>;
  guardTotal: number;
  inspectTotal: number;
}

const REFACTOR_KEYWORD = /重构/;

export function sanitizeProgress(message?: string, stage?: string): string {
  if (stage === 'sop') return t('page.dashboard.sanitize.loadingRules');
  if (stage === 'guard') return message?.includes('未通过') ? message : t('page.dashboard.sanitize.guarding');
  if (stage === 'inspect') return t('page.dashboard.sanitize.inspecting');
  if (stage === 'autofix') return message || t('page.dashboard.sanitize.autoFixing');
  if (stage === 'done') return message && !REFACTOR_KEYWORD.test(message) ? message : t('page.dashboard.sanitize.done');
  if (!message || REFACTOR_KEYWORD.test(message)) return t('page.dashboard.running');
  return message;
}

export function extractSummary(report: PipelineReportData): CheckSummary {
  const s = report.summary as Record<string, unknown> | undefined;
  if (s && typeof s.total === 'number') {
    const guard = (s.guard ?? {}) as Record<string, number>;
    const inspect = (s.inspect ?? {}) as Record<string, number>;
    return {
      total: Number(s.total) || 0,
      passed: Number(s.passed) || 0,
      failed: Number(s.failed) || 0,
      skipped: Number(s.skipped) || 0,
      errors: Number(s.errors) || 0,
      failedItems: Array.isArray(s.failedItems) ? (s.failedItems as CheckSummary['failedItems']) : [],
      guardTotal: Number(guard.total) || 0,
      inspectTotal: Number(inspect.total) || 0,
    };
  }

  // 兼容未带 summary 的旧报告（RuleEngineReport 形态）
  const g = report.guard as unknown as Record<string, number> | undefined;
  const i = report.inspect as unknown as Record<string, number> | undefined;
  return {
    total: (g?.total ?? 0) + (i?.total ?? 0),
    passed: (g?.passed ?? 0) + (i?.passed ?? 0),
    failed: (g?.failed ?? 0) + (i?.failed ?? 0),
    skipped: (g?.skipped ?? 0) + (i?.skipped ?? 0),
    errors: (g?.errors ?? 0) + (i?.errors ?? 0),
    failedItems: [],
    guardTotal: g?.total ?? 0,
    inspectTotal: i?.total ?? 0,
  };
}

/** 健康分数加载（null = 尚未体检或读取失败） */
export function useDashboardStatus(projectPath: string) {
  const [healthScore, setHealthScore] = useState<number | null>(null);

  const refreshScore = useCallback(() => {
    getScore(projectPath).then((s) => setHealthScore(s?.score ?? null));
  }, [projectPath]);

  useEffect(() => {
    refreshScore();
  }, [refreshScore]);

  return { healthScore, refreshScore };
}

/** 一键体检进度订阅：进度来自统一任务中心（tasks:changed），autofix 通知独立保留 */
export function usePipelineProgress(projectPath: string) {
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
  const [autoFixNotice, setAutoFixNotice] = useState<string | null>(null);
  const task = useTask('pipeline', projectPath);

  useEffect(() => {
    if (task && (task.status === 'queued' || task.status === 'running')) {
      const message = task.message && REFACTOR_KEYWORD.test(task.message)
        ? sanitizeProgress(task.message, task.stage)
        : (task.message ?? '');
      setPipelineProgress({ stage: task.stage ?? 'running', message, progress: task.progress });
    } else if (task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) {
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

function notifyCheckResult(report: PipelineReportData, summary: CheckSummary, toast: (msg: string, variant?: ToastVariant) => void) {
  if (report.error) {
    toast(t('page.dashboard.toast.failed', { error: report.error }), 'error');
  } else if (summary.failed > 0 || summary.errors > 0) {
    toast(t('page.dashboard.toast.foundIssues', { count: summary.failed + summary.errors }), 'warning');
  } else if (summary.total === 0) {
    toast(t('page.dashboard.toast.noValidItems'), 'warning');
  } else {
    toast(t('page.dashboard.toast.completed', { total: summary.total, passed: summary.passed }), 'success');
  }
}

/** 一键体检执行：运行流水线 + 进度提示 + 结果汇总 */
export function useOneClickCheck(
  projectPath: string,
  toast: (msg: string, variant?: ToastVariant) => void,
  setPipelineProgress: (p: PipelineProgress | null) => void,
  setAutoFixNotice: (n: string | null) => void,
) {
  const [running, setRunning] = useState(false);
  const [lastReport, setLastReport] = useState<PipelineReportData | null>(null);

  const handleOneClickCheck = useCallback(async () => {
    if (!projectPath) {
      toast(t('page.dashboard.toast.addProjectFirst'), 'warning');
      return;
    }
    setRunning(true);
    setPipelineProgress({ stage: 'sop', message: t('page.dashboard.sanitize.loadingRules'), progress: 0.05 });
    setAutoFixNotice(null);
    setLastReport(null);
    try {
      const report = await runPipeline(projectPath, { dryRun: false, sop: true });
      setLastReport(report);
      notifyCheckResult(report, extractSummary(report), toast);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('page.dashboard.toast.executionFailed');
      toast(msg, 'error');
    } finally {
      setRunning(false);
      setPipelineProgress(null);
    }
  }, [projectPath, toast, setPipelineProgress, setAutoFixNotice]);

  return { running, lastReport, clearReport: () => setLastReport(null), handleOneClickCheck };
}

/** 复制未通过检查项到 AI 修复 */
export function useCopyFailedIssues(projectPath: string) {
  const { toast } = useToast();

  const copyFailedIssues = useCallback((items: CheckSummary['failedItems']) => {
    const text = buildAiFixPrompt(
      projectPath,
      items.map((it) => ({
        source: it.stage === 'guard' ? t('page.dashboard.copy.guardSource') : t('page.dashboard.copy.inspectSource'),
        ruleId: it.id,
        message: `${it.name} — ${it.message}`,
      })),
    );
    void copyTextToClipboard(text).then(
      (ok) =>
        ok
          ? toast(t('page.dashboard.toast.copiedIssues', { count: items.length }))
          : toast(t('page.dashboard.toast.copyFailed'), 'error'),
      () => toast(t('page.dashboard.toast.copyFailed'), 'error'),
    );
  }, [projectPath, toast]);

  return { copyFailedIssues };
}

/** 仪表盘页全部状态与副作用：版本/分数加载、一键体检、进度监听、复制问题 */
export function useDashboardPage(projectPath: string) {
  const { toast } = useToast();
  const { healthScore, refreshScore } = useDashboardStatus(projectPath);
  const { pipelineProgress, autoFixNotice, setPipelineProgress, setAutoFixNotice } = usePipelineProgress(projectPath);
  const { running, lastReport, clearReport, handleOneClickCheck } = useOneClickCheck(
    projectPath,
    toast,
    setPipelineProgress,
    setAutoFixNotice,
  );
  const { copyFailedIssues } = useCopyFailedIssues(projectPath);

  const handleOneClickCheckAndRefresh = useCallback(async () => {
    await handleOneClickCheck();
    refreshScore();
  }, [handleOneClickCheck, refreshScore]);

  const progressLabel = sanitizeProgress(pipelineProgress?.message, pipelineProgress?.stage);
  const summary = lastReport ? extractSummary(lastReport) : null;

  return {
    score: healthScore,
    running,
    progressLabel,
    pipelineProgress,
    autoFixNotice,
    lastReport,
    summary,
    handleOneClickCheck: handleOneClickCheckAndRefresh,
    copyFailedIssues,
    clearReport,
  };
}
