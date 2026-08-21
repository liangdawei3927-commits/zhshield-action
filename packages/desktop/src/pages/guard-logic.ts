import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { runGuard, listGuardReports, reportFalsePositive as submitFalsePositive } from '../services/engineApi';
import { useFalsePositiveCount } from '../components/hooks/useFalsePositiveCount';
import type { GuardReportData, GuardReportRecordData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';
import { useTaskRun } from '../task-store';

export const SEVERITY_LABELS: Record<string, string> = { critical: 'severity.critical', high: 'severity.high', medium: 'severity.medium', low: 'severity.low' };
export const SEVERITY_COLORS: Record<string, { color: string; bg: string }> = {
  critical: { color: 'rgb(var(--zh-danger-dark))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  high: { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  medium: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)' },
  low: { color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)' },
};
export const STATUS_LABELS: Record<string, { textKey: string; color: string; bg: string }> = {
  pass: { textKey: 'page.guard.status.pass', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.1)' },
  warn: { textKey: 'page.guard.status.warn', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)' },
  fail: { textKey: 'page.guard.status.fail', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
};

export interface GuardLevelInfo {
  level: 'L1' | 'L2' | 'L3';
  labelKey: string;
  triggerSource: string;
  status: 'pass' | 'warn' | 'fail' | 'idle';
  blockingCount: number;
  lastAt: string | null;
}

const LEVEL_TRIGGERS: Array<{ level: 'L1' | 'L2' | 'L3'; labelKey: string; triggerSource: string }> = [
  { level: 'L1', labelKey: 'page.guard.trigger.preCommit', triggerSource: 'pre-commit' },
  { level: 'L2', labelKey: 'page.guard.trigger.prePush', triggerSource: 'pre-push' },
  { level: 'L3', labelKey: 'page.guard.level.L3', triggerSource: 'ci' },
];

/** 历史记录 → 三级拦截关卡聚合：每个关卡取最近一次记录的状态与拦截数 */
export function buildGuardLevels(history: GuardReportRecordData[]): GuardLevelInfo[] {
  return LEVEL_TRIGGERS.map(({ level, labelKey, triggerSource }) => {
    const records = history.filter((r) => r.triggerSource === triggerSource);
    if (records.length === 0) {
      return { level, labelKey, triggerSource, status: 'idle', blockingCount: 0, lastAt: null };
    }
    const latest = records.toSorted(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )[0];
    const status: GuardLevelInfo['status'] = latest.summary.blocking > 0 ? 'fail' : latest.summary.warnings > 0 ? 'warn' : 'pass';
    const blockingCount = records.reduce((acc, r) => acc + r.summary.blocking, 0);
    return { level, labelKey, triggerSource, status, blockingCount, lastAt: latest.timestamp };
  });
}

/** 门禁整体状态：任一关卡拦截 → 拦截；有警告 → 警告；否则通过 */
export function deriveGuardStatus(levels: GuardLevelInfo[]): { status: 'pass' | 'warn' | 'fail'; label: string } {
  if (levels.some((l) => l.status === 'fail')) return { status: 'fail', label: t('page.guard.statusShort.fail') };
  if (levels.some((l) => l.status === 'warn')) return { status: 'warn', label: t('page.guard.statusShort.warn') };
  if (levels.some((l) => l.status === 'pass')) return { status: 'pass', label: t('page.guard.statusShort.pass') };
  return { status: 'pass', label: t('page.guard.statusShort.idle') };
}

/** 落库记录 → 页面报告（与 engine 侧 toGuardReportData 映射一致，name 即 checkId） */
export function toGuardReportDataFromRecord(record: GuardReportRecordData): GuardReportData {
  return {
    summary: {
      totalChecks: record.summary.total,
      passed: record.summary.passed,
      blocked: record.summary.blocking,
      warnings: record.summary.warnings,
    },
    checks: record.checks.map((c) => ({
      id: c.checkId,
      name: c.checkId,
      status: c.status === 'passed' ? 'pass' : c.status === 'failed' || c.status === 'error' ? 'fail' : 'warn',
      message: c.message,
      severity: c.severity === 'error' ? 'high' : c.severity === 'warning' ? 'medium' : 'low',
    })),
    metadata: { duration: 0, timestamp: record.timestamp },
  };
}

/** 门禁扫描运行：loading/进度来自任务中心，状态 + 报告 */
function useGuardRun(projectPath: string): {
  loading: boolean;
  progressLabel: string;
  report: GuardReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<GuardReportData | null>(null);
  const { loading, progressLabel } = useTaskRun('guard', projectPath);

  useEffect(() => {
    let cancelled = false;
    void listGuardReports(projectPath, 1)
      .then((records) => {
        if (cancelled || records.length === 0) return;
        setReport(toGuardReportDataFromRecord(records[0]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleScan = useCallback(async () => {
    try {
      const result = await runGuard(projectPath);
      setReport(result);
    } catch {
      setReport(null);
    }
  }, [projectPath]);

  return { loading, progressLabel, report, handleScan };
}

/** 门禁检查项 → AI 修复问题条目 */
function guardCheckToAiIssue(check: GuardReportData['checks'][number]): AiFixIssue {
  return {
    source: t('page.guard.source'),
    ruleId: check.id,
    severity: check.severity ? t(SEVERITY_LABELS[check.severity] ?? check.severity) : undefined,
    message: check.message,
  };
}

/** 复制单个/全部检查项到 AI 修复 */
function useGuardCopyToAi(projectPath: string): {
  copyToAi: (check: GuardReportData['checks'][number]) => void;
  copyAllToAi: (checks: GuardReportData['checks'][number][]) => void;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    (check: GuardReportData['checks'][number]) => {
      const text = buildAiFixPrompt(projectPath, [guardCheckToAiIssue(check)]);
      void copyTextToClipboard(text).then(
        (ok) => (ok ? toast(t('toast.copiedToAi')) : toast(t('toast.copyFailed'), 'error')),
        () => toast(t('toast.copyFailed'), 'error'),
      );
    },
    [projectPath, toast],
  );

  /** 一键复制全部未通过检查项到 AI 修复 */
  const copyAllToAi = useCallback(
    (checks: GuardReportData['checks'][number][]) => {
      if (checks.length === 0) return;
      const text = buildAiFixPrompt(projectPath, checks.map(guardCheckToAiIssue));
      void copyTextToClipboard(text).then(
        (ok) => (ok ? toast(t('page.guard.copiedAll', { count: checks.length })) : toast(t('toast.copyFailed'), 'error')),
        () => toast(t('toast.copyFailed'), 'error'),
      );
    },
    [projectPath, toast],
  );

  return { copyToAi, copyAllToAi };
}

/** 门禁历史拦截记录：落库的最近报告（hook 触发 + 手动扫描） */
function useGuardHistory(projectPath: string): {
  history: GuardReportRecordData[];
  refreshHistory: () => Promise<void>;
} {
  const [history, setHistory] = useState<GuardReportRecordData[]>([]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listGuardReports(projectPath));
    } catch {
      setHistory([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  return { history, refreshHistory };
}

/** 标记单个检查项为误报：提交智汇大脑校准，toast 确认 */
function useGuardReportFalsePositive(projectPath: string): {
  reportFalsePositive: (check: GuardReportData['checks'][number]) => void;
} {
  const { toast } = useToast();

  const reportFalsePositive = useCallback(
    (check: GuardReportData['checks'][number]) => {
      void submitFalsePositive(projectPath, {
        source: 'guard',
        ruleId: check.id,
        title: check.name,
        message: check.message,
        severity: check.severity,
      }).then(
        (result) => (result.ok ? toast(t('page.guard.falsePositiveSubmitted')) : toast(result.reason ?? t('page.guard.reportFailed'), 'error')),
        () => toast(t('page.guard.reportFailed'), 'error'),
      );
    },
    [projectPath, toast],
  );

  return { reportFalsePositive };
}

/** 门禁页全部状态与副作用：扫描、复制到 AI、误报反馈、历史拦截记录 */
export function useGuardPage(projectPath: string) {
  const { loading, progressLabel, report, handleScan } = useGuardRun(projectPath);
  const { copyToAi, copyAllToAi } = useGuardCopyToAi(projectPath);
  const { reportFalsePositive } = useGuardReportFalsePositive(projectPath);
  const { history, refreshHistory } = useGuardHistory(projectPath);
  const falsePositiveCount = useFalsePositiveCount(projectPath, 'guard');

  const handleScanAndRefresh = useCallback(async () => {
    await handleScan();
    await refreshHistory();
  }, [handleScan, refreshHistory]);

  return { loading, progressLabel, report, copyToAi, copyAllToAi, reportFalsePositive, handleScan: handleScanAndRefresh, history, falsePositiveCount };
}
