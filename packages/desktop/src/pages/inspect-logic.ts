import { useCallback, useState } from 'react';
import { t } from '@zh/i18n';
import { runInspect } from '../services/engineApi';
import type { InspectionReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';
import { useDailyAutoCheck } from '../hooks/useDailyAutoCheck';
import { useTaskRun } from '../task-store';

export const STATUS_CONFIG: Record<string, { labelKey: string; color: string; bg: string; icon: string }> = {
  pass: { labelKey: 'page.inspect.status.pass', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.1)', icon: '✓' },
  warn: { labelKey: 'page.inspect.status.warn', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)', icon: '!' },
  fail: { labelKey: 'page.inspect.status.fail', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', icon: '✗' },
};

/** 巡检报告状态：执行巡检并保存结果 */
function useInspectReport(projectPath: string): {
  report: InspectionReportData | null;
  run: () => Promise<void>;
} {
  const [report, setReport] = useState<InspectionReportData | null>(null);
  const run = useCallback(async () => {
    try {
      setReport(await runInspect(projectPath));
    } catch {
      setReport(null);
    }
  }, [projectPath]);
  return { report, run };
}

/** 巡检运行：loading/进度来自任务中心，手动触发 */
function useInspectRun(projectPath: string): {
  report: InspectionReportData | null;
  loading: boolean;
  progressLabel: string;
  startInspect: () => Promise<void>;
} {
  const { report, run } = useInspectReport(projectPath);
  const { loading, progressLabel } = useTaskRun('inspect', projectPath);

  const startInspect = useCallback(() => run(), [run]);

  return { report, loading, progressLabel, startInspect };
}

/** 复制单个检查项到 AI 修复 */
function useInspectCopyToAi(projectPath: string): {
  copyToAi: (item: InspectionReportData['checks'][number]) => void;
  copyAllToAi: (items: InspectionReportData['checks']) => void;
} {
  const { toast } = useToast();

  const runCopy = useCallback(
    (issues: AiFixIssue[]) => {
      const text = buildAiFixPrompt(projectPath, issues);
      void copyTextToClipboard(text).then(
        (ok) => (ok ? toast(t('toast.copiedToAi')) : toast(t('toast.copyFailed'), 'error')),
        () => toast(t('toast.copyFailed'), 'error'),
      );
    },
    [projectPath, toast],
  );

  const copyToAi = useCallback(
    (item: InspectionReportData['checks'][number]) => {
      runCopy([{ source: t('page.inspect.source'), ruleId: item.id, message: `${item.name} — ${item.detail}` }]);
    },
    [runCopy],
  );

  const copyAllToAi = useCallback(
    (items: InspectionReportData['checks']) => {
      const failed = items.filter((i) => i.status !== 'pass');
      if (failed.length === 0) return;
      runCopy(failed.map((item) => ({ source: t('page.inspect.source'), ruleId: item.id, message: `${item.name} — ${item.detail}` })));
    },
    [runCopy],
  );

  return { copyToAi, copyAllToAi };
}

/** 巡检页全部状态与副作用：每日 0 点自动巡检、复制到 AI */
export function useInspectPage(projectPath: string) {
  const { report, loading, progressLabel, startInspect } = useInspectRun(projectPath);
  const { copyToAi, copyAllToAi } = useInspectCopyToAi(projectPath);
  useDailyAutoCheck(projectPath, () => void startInspect());

  return { report, loading, progressLabel, copyToAi, copyAllToAi, startInspect };
}
