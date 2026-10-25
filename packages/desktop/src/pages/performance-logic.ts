import { useCallback, useState } from 'react';
import { t } from '@zh/i18n';
import { runPerformance } from '../services/engineApi';
import type { ElectronAPI, PerformanceReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard } from '../utils/copyToAi';
import { useRunWithReport } from '../hooks/useRunWithReport';
import { useTaskRun } from '../task-store';

/** preload 已暴露 openExternal（trae:// 唤起），但 ElectronAPI 类型未声明，此处补齐 */
export type ElectronApiWithExternal = ElectronAPI & {
  openExternal?: (url: string) => Promise<boolean>;
};

export const SEVERITY_CONFIG: Record<string, { color: string; bg: string; textKey: string }> = {
  critical: {
    color: 'rgb(var(--zh-danger-dark))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
    textKey: 'severity.critical',
  },
  high: {
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
    textKey: 'page.performance.severity.high',
  },
  medium: {
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.1)',
    textKey: 'page.performance.severity.medium',
  },
  low: {
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.1)',
    textKey: 'page.performance.severity.low',
  },
  info: {
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-bg-primary))',
    textKey: 'severity.info',
  },
};

/** 将性能问题映射为 AI 修复提示项 */
function toPerformanceAiIssue(issue: PerformanceReportData['issues'][number]) {
  return {
    source: t('page.performance.source'),
    ruleId: issue.ruleId,
    severity: SEVERITY_CONFIG[issue.severity]
      ? t(SEVERITY_CONFIG[issue.severity].textKey)
      : issue.severity,
    file: issue.file,
    line: issue.line,
    message: issue.message,
    suggestion: issue.suggestion,
    domain: 'performance',
  };
}

/** 性能扫描运行：loading/进度来自任务中心，状态 + 报告 */
function usePerformanceRun(projectPath: string): {
  loading: boolean;
  progress: number;
  statusMessage: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  /** 取消当前任务（用户点「停止」）：主进程立刻让等待方返回，UI 不等执行器收尾 */
  cancel: () => void;
  /** 已发出取消、等任务中心确认（按钮显示「停止中…」并禁用） */
  stopping: boolean;
  queued: boolean;
  /** 排队位置（1 起；仅 queued 时有值） */
  queuePosition?: number;
  report: PerformanceReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<PerformanceReportData | null>(null);
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } = useTaskRun(
    'performance',
    projectPath,
  );
  const { handleScan } = useRunWithReport(projectPath, runPerformance, setReport);

  return { loading, progress, statusMessage, queued, queuePosition, cancel, stopping, report, handleScan };
}

/** 单条 / 全部复制到 AI（并唤起 Trae） */
function usePerformanceCopy(
  projectPath: string,
  report: PerformanceReportData | null,
): {
  copyToAi: (issue: PerformanceReportData['issues'][number]) => Promise<void>;
  copyAllToAi: () => Promise<void>;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    async (issue: PerformanceReportData['issues'][number]) => {
      const text = buildAiFixPrompt(projectPath, [toPerformanceAiIssue(issue)]);
      const copied = await copyTextToClipboard(text);
      if (!copied) {
        toast(t('toast.copyFailed'), 'error');
        return;
      }
      const api = window.electronAPI as ElectronApiWithExternal | undefined;
      if (api?.openExternal) {
        const opened = await api.openExternal('trae://');
        toast(opened ? t('toast.copyFixOpenedTrae') : t('toast.copyFixManualTrae'));
      } else {
        toast(t('toast.copiedToAi'));
      }
    },
    [projectPath, toast, t],
  );

  /** 一键复制全部问题到 AI（并打开 Trae） */
  const copyAllToAi = useCallback(async () => {
    if (!report || report.issues.length === 0) return;
    const text = buildAiFixPrompt(projectPath, report.issues.map(toPerformanceAiIssue));
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      toast(t('toast.copyFailed'), 'error');
      return;
    }
    const api = window.electronAPI as ElectronApiWithExternal | undefined;
    if (api?.openExternal) {
      const opened = await api.openExternal('trae://');
      toast(
        opened
          ? t('toast.copyAllOpenedTrae', { count: report.issues.length })
          : t('toast.copyAllManualTrae', { count: report.issues.length }),
      );
    } else {
      toast(t('toast.copyAllCopiedToAi', { count: report.issues.length }));
    }
  }, [projectPath, report, toast, t]);

  return { copyToAi, copyAllToAi };
}

/** 性能页全部状态与副作用：扫描、单条/全部复制到 AI（并唤起 Trae） */
export function usePerformancePage(projectPath: string) {
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping, report, handleScan } =
    usePerformanceRun(projectPath);
  const { copyToAi, copyAllToAi } = usePerformanceCopy(projectPath, report);

  return {
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    report,
    copyToAi,
    copyAllToAi,
    handleScan,
  };
}
