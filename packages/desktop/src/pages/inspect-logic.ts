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
import { isCancelledError } from '../services/cancel-error';

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
  // notApplicable：检测对象在本项目不存在（如无 Web 框架的 Helmet/CSRF）。
  // 与 attention（未执行/未产出结论）不同：这里「检查过，结论是没有可检对象」。
  notApplicable: {
    labelKey: 'page.inspect.status.notApplicable',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.1)',
    icon: '—',
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
  run: (opts?: { origin?: 'auto' }) => Promise<void>;
} {
  const [report, setReport] = useState<InspectionReportData | null>(null);
  const [failure, setFailure] = useState<InspectFailure | null>(null);
  const persisted = usePersistedReport(projectPath);

  const run = useCallback(
    async (opts?: { origin?: 'auto' }) => {
      setFailure(null);
      try {
        // origin（触发来源）随 options 传给主进程：主进程把它从去重请求键里剥掉，
        // 只挂在任务上作诊断元数据——手动/自动任务依然互相复用不重复扫。
        const pipeline = await runPipeline(
          projectPath,
          opts?.origin ? { sop: true, origin: opts.origin } : { sop: true },
        );
      const outcome = toInspectOutcome(pipeline);
      if (outcome.kind === 'cancelled') {
        // 用户点「停止」不是失败：不落失败页、保留已有报告。
        // 落了失败页就等于把取消说成故障，还会在按钮下方顶出一行红色错误文案。
        return;
      }
      if (outcome.kind === 'failed') {
        setReport(null);
        setFailure(outcome);
        return;
      }
      setReport(outcome.report);
    } catch (err: unknown) {
      // 用户点「停止」不是失败：不落失败页，保留已有报告
      if (isCancelledError(err)) return;
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

/** 巡检运行：loading/进度来自任务中心（自动巡检与手动点击共用同一任务通道） */
function useInspectRun(projectPath: string): {
  report: InspectionReportData | null;
  persisted: InspectionReportData | null;
  failure: InspectFailure | null;
  loading: boolean;
  progress: number;
  statusMessage: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  queued: boolean;
  /** 排队位置（1 起；仅 queued 时有值） */
  queuePosition?: number;
  /** 取消当前任务（用户点「停止」）：主进程立刻让等待方返回，UI 不等执行器收尾 */
  cancel: () => void;
  /** 已发出取消、等任务中心确认（按钮显示「停止中…」并禁用） */
  stopping: boolean;
  startInspect: (opts?: { origin?: 'auto' }) => Promise<void>;
} {
  const { report, persisted, failure, run } = useInspectReport(projectPath);
  // 数据源已收敛为 SOP 流水线，任务中心推送同为 pipeline 任务（kind 随主链路对齐）。
  // 忙态文案不区分触发来源：任务在跑按钮就显示「巡检中」，谁扣的扳机用户无需关心。
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } =
    useTaskRun('pipeline', projectPath);

  const startInspect = useCallback((opts?: { origin?: 'auto' }) => run(opts), [run]);

  return {
    report,
    persisted,
    failure,
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
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
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    startInspect,
  } = useInspectRun(projectPath);
  const { copyToAi, copyAllToAi } = useInspectCopyToAi(projectPath);
  // 自动巡检带 origin='auto'：仅作为任务上的诊断元数据（首扫/每日/定时/手动
  // 触发的任务在 UI 上一视同仁），手动/自动同参任务互相复用不重复扫。
  useDailyAutoCheck('inspect', projectPath, () => void startInspect({ origin: 'auto' }), 'pipeline');

  return {
    report,
    persisted,
    failure,
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    copyToAi,
    copyAllToAi,
    startInspect,
  };
}
