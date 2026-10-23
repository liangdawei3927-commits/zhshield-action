import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { getDomainReport, runPipeline } from '../services/engineApi';
import type { InspectionReportData } from '../types/electron';
import { selectIssueChecks, toInspectOutcome } from './inspect-sop-mapper';
import { toInspectionReportDataFromSnapshot } from './inspect-snapshot-mapper';
import type { InspectFailure } from './inspect-sop-mapper';
import { useToast } from '../components/ui/Toast';
import { copyIssuesToAi } from '../utils/copyToAi';
import { useDailyAutoCheck } from '../hooks/useDailyAutoCheck';
import { useTaskRun } from '../task-store';

export const STATUS_CONFIG: Record<
  string,
  { labelKey: string; color: string; bg: string; icon: string }
> = {
  pass: {
    labelKey: 'page.inspect.status.pass',
    color: 'rgb(var(--zh-success))',
    bg: 'rgb(var(--zh-success) / 0.1)',
    icon: '✓',
  },
  warn: {
    labelKey: 'page.inspect.status.warn',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.1)',
    icon: '!',
  },
  fail: {
    labelKey: 'page.inspect.status.fail',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
    icon: '✗',
  },
  attention: {
    labelKey: 'page.inspect.status.attention',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.1)',
    icon: '?',
  },
  // info：仅历史快照（issues-only）会出现（快照含 info 级问题条目）。
  // 与 attention（规则未执行/未产出结论）语义不同，不可混用。
  // 文案复用既有全局键 severity.info，避免新增键（Vite 不监听 root 外的 locale JSON，
  // 新键在 dev 会话里可能渲染成裸 key）。
  info: {
    labelKey: 'severity.info',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.1)',
    icon: 'i',
  },
};

/**
 * 读回该域最近一次落盘快照（**仅问题项**），与本次实时报告彻底分开：
 * - 实时报告走 `report`（完整：通过/问题/未检测齐全）
 * - 历史快照走 `persisted`（通过项未落盘，`coverage='issues-only'`）
 * 混在一起会把「快照」当「刚扫出来的结果」显示，也会让「扫描中」错误地显示旧报告。
 * 这里只解决「有评分却没有详情入口」：有快照 → 详情按钮出现且点得进去。
 */
function usePersistedReport(projectPath: string): InspectionReportData | null {
  const [persisted, setPersisted] = useState<InspectionReportData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPersisted(null);
    void getDomainReport(projectPath, 'inspect').then((snapshot) => {
      if (cancelled) return;
      setPersisted(toInspectionReportDataFromSnapshot(snapshot));
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return persisted;
}

/**
 * 巡检报告状态：跑 SOP 质量流水线并映射 InspectionReportData（见 inspect-sop-mapper）。
 * failure 与 report 互斥：执行失败必须落到 failure，不得静默退化为 report=null 的空态。
 */
function useInspectReport(projectPath: string): {
  report: InspectionReportData | null;
  persisted: InspectionReportData | null;
  failure: InspectFailure | null;
  run: () => Promise<void>;
} {
  const [report, setReport] = useState<InspectionReportData | null>(null);
  const [failure, setFailure] = useState<InspectFailure | null>(null);
  const persisted = usePersistedReport(projectPath);

  const run = useCallback(async () => {
    setFailure(null);
    try {
      const pipeline = await runPipeline(projectPath, { sop: true });
      const outcome = toInspectOutcome(pipeline);
      if (outcome.kind === 'failed') {
        setReport(null);
        setFailure(outcome);
        return;
      }
      setReport(outcome.report);
    } catch (err: unknown) {
      setReport(null);
      setFailure({
        kind: 'failed',
        messageKey: 'page.inspect.errorTitle',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectPath]);
  return { report, persisted, failure, run };
}

/** 巡检运行：loading/进度来自任务中心，手动触发 */
function useInspectRun(projectPath: string): {
  report: InspectionReportData | null;
  persisted: InspectionReportData | null;
  failure: InspectFailure | null;
  loading: boolean;
  progress: number;
  progressLabel: string;
  statusMessage: string;
  startInspect: () => Promise<void>;
} {
  const { report, persisted, failure, run } = useInspectReport(projectPath);
  // 数据源已收敛为 SOP 流水线，任务中心推送同为 pipeline 任务（kind 随主链路对齐）
  const { loading, progress, progressLabel, statusMessage } = useTaskRun('pipeline', projectPath);

  const startInspect = useCallback(() => run(), [run]);

  return {
    report,
    persisted,
    failure,
    loading,
    progress,
    progressLabel,
    statusMessage,
    startInspect,
  };
}

function useInspectCopyToAi(projectPath: string): {
  copyToAi: (item: InspectionReportData['checks'][number]) => void;
  copyAllToAi: (items: InspectionReportData['checks']) => void;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    (item: InspectionReportData['checks'][number]) => {
      copyIssuesToAi(projectPath, toast, [
        {
          source: t('page.inspect.source'),
          ruleId: item.id,
          message: `${item.name} — ${item.detail}`,
          domain: 'inspect',
        },
      ]);
    },
    [projectPath, toast],
  );

  const copyAllToAi = useCallback(
    (items: InspectionReportData['checks']) => {
      const failed = selectIssueChecks(items);
      if (failed.length === 0) return;
      copyIssuesToAi(
        projectPath,
        toast,
        failed.map((item) => ({
          source: t('page.inspect.source'),
          ruleId: item.id,
          message: `${item.name} — ${item.detail}`,
        })),
      );
    },
    [projectPath, toast],
  );

  return { copyToAi, copyAllToAi };
}

/** 巡检页全部状态与副作用：每天首次进入本页自动巡检一次、复制到 AI */
export function useInspectPage(projectPath: string) {
  const {
    report,
    persisted,
    failure,
    loading,
    progress,
    progressLabel,
    statusMessage,
    startInspect,
  } = useInspectRun(projectPath);
  const { copyToAi, copyAllToAi } = useInspectCopyToAi(projectPath);
  useDailyAutoCheck('inspect', projectPath, () => void startInspect());

  return {
    report,
    persisted,
    failure,
    loading,
    progress,
    progressLabel,
    statusMessage,
    copyToAi,
    copyAllToAi,
    startInspect,
  };
}
