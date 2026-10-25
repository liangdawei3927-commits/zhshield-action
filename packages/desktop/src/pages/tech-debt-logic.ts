import { useCallback, useState } from 'react';
import { t } from '@zh/i18n';
import {
  runTechDebt,
  planDebtRepayment,
  verifyDebtRepaid,
  dismissDebtAction,
} from '../services/engineApi';
import type { TechDebtReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { copyIssuesToAi } from '../utils/copyToAi';
import { useTaskRun } from '../task-store';
import { useRunWithReport } from '../hooks/useRunWithReport';
import { isCancelledError } from '../services/cancel-error';

/**
 * 债务类别配置（与 @zh/scoring tech-debt DebtCategory 对齐，5 类 4 色）：
 * security 红 / architecture 橙 / quality 绿 / dependency 橙 / duplication 灰
 * （颜色走设计系统 token：#DC2626 → zh-danger、#B45309 → zh-warning、#047857 → zh-success-700、#6B7280 → zh-muted）
 */
export const DEBT_CATEGORY_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> =
  {
    security: {
      color: 'rgb(var(--zh-danger))',
      bg: 'rgb(var(--zh-danger) / 0.1)',
      labelKey: 'page.techdebt.category.security',
    },
    architecture: {
      color: 'rgb(var(--zh-warning))',
      bg: 'rgb(var(--zh-warning) / 0.12)',
      labelKey: 'page.techdebt.category.architecture',
    },
    quality: {
      color: 'rgb(var(--zh-success-700))',
      bg: 'rgb(var(--zh-success) / 0.08)',
      labelKey: 'page.techdebt.category.quality',
    },
    dependency: {
      color: 'rgb(var(--zh-warning))',
      bg: 'rgb(var(--zh-warning) / 0.12)',
      labelKey: 'page.techdebt.category.dependency',
    },
    duplication: {
      color: 'rgb(var(--zh-muted))',
      bg: 'rgb(var(--zh-muted) / 0.08)',
      labelKey: 'page.techdebt.category.duplication',
    },
  };

/** 债务类别展示顺序（构成占比条固定排序） */
export const DEBT_CATEGORY_ORDER: string[] = [
  'security',
  'quality',
  'architecture',
  'duplication',
  'dependency',
];

/** 动作状态配置（pending / planned / in-progress / repaid / dismissed） */
export const ACTION_STATUS_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> =
  {
    pending: {
      color: 'rgb(var(--zh-warning))',
      bg: 'rgb(var(--zh-warning) / 0.12)',
      labelKey: 'page.techdebt.status.pending',
    },
    planned: {
      color: 'rgb(var(--zh-info))',
      bg: 'rgb(var(--zh-info) / 0.1)',
      labelKey: 'page.techdebt.status.planned',
    },
    'in-progress': {
      color: 'rgb(var(--zh-warning))',
      bg: 'rgb(var(--zh-warning) / 0.12)',
      labelKey: 'page.techdebt.status.inProgress',
    },
    repaid: {
      color: 'rgb(var(--zh-success-700))',
      bg: 'rgb(var(--zh-success) / 0.08)',
      labelKey: 'page.techdebt.status.repaid',
    },
    dismissed: {
      color: 'rgb(var(--zh-muted))',
      bg: 'rgb(var(--zh-muted) / 0.08)',
      labelKey: 'page.techdebt.status.dismissed',
    },
  };

/** 利息四因子配置（D.7 可解释验收：severity × hotness × density × exposure） */
export const INTEREST_FACTOR_CONFIG: Array<{
  key: keyof TechDebtReportData['actionList'][number]['interestBreakdown'];
  labelKey: string;
  color: string;
}> = [
  {
    key: 'severityFactor',
    labelKey: 'page.techdebt.factor.severity',
    color: 'rgb(var(--zh-danger))',
  },
  {
    key: 'hotnessFactor',
    labelKey: 'page.techdebt.factor.hotness',
    color: 'rgb(var(--zh-warning))',
  },
  { key: 'densityFactor', labelKey: 'page.techdebt.factor.density', color: 'rgb(var(--zh-info))' },
  {
    key: 'exposureFactor',
    labelKey: 'page.techdebt.factor.exposure',
    color: 'rgb(var(--zh-success-700))',
  },
];

/** 利息因子归一化分母：四因子最大取值（severity/hotness ≤ 3，density ≤ 2，exposure ≤ 1.5） */
export const INTEREST_FACTOR_MAX = 3;

/** 债务指数分档颜色：<40 绿 / <70 橙 / ≥70 红 */
export function debtIndexColor(index: number): string {
  if (index >= 70) return 'rgb(var(--zh-danger))';
  if (index >= 40) return 'rgb(var(--zh-warning))';
  return 'rgb(var(--zh-success-700))';
}

/** 技术债盘点运行：loading / 进度统一来自任务中心 techdebt 任务 */
async function scanTechDebt(projectPath: string): Promise<TechDebtReportData | null> {
  try {
    return await runTechDebt(projectPath);
  } catch (err) {
    // 用户点「停止」不是失败：原样抛给共用骨架，由它识别取消并**保留已有报告**
    // （吞成 null 会把用户正在看的报告一起清掉）。
    if (isCancelledError(err)) throw err;
    return null;
  }
}

function markActionStatus(
  report: TechDebtReportData | null,
  actionId: string,
  status: TechDebtReportData['actionList'][number]['status'],
): TechDebtReportData | null {
  if (!report) return report;
  return {
    ...report,
    actionList: report.actionList.map((a) => (a.actionId === actionId ? { ...a, status } : a)),
  };
}

async function runDebtAction(
  actionId: string,
  setLoading: (id: string | null) => void,
  action: () => Promise<void>,
): Promise<void> {
  setLoading(actionId);
  try {
    await action();
  } finally {
    setLoading(null);
  }
}

function useTechDebtActions(
  projectPath: string,
  setReport: React.Dispatch<React.SetStateAction<TechDebtReportData | null>>,
): {
  planLoading: string | null;
  verifyLoading: string | null;
  handlePlan: (
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  handleVerify: (actionId: string) => Promise<void>;
  handleDismiss: (actionId: string) => Promise<void>;
} {
  const [planLoading, setPlanLoading] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState<string | null>(null);
  const handlePlan = useCallback(
    async (actionId: string, opts?: { sprint?: string; gate?: 'allow-with-record' }) => {
      await runDebtAction(actionId, setPlanLoading, async () => {
        await planDebtRepayment(projectPath, actionId, opts);
        setReport((prev) => markActionStatus(prev, actionId, 'planned'));
      });
    },
    [projectPath, setReport],
  );
  const handleVerify = useCallback(
    async (actionId: string) => {
      await runDebtAction(actionId, setVerifyLoading, async () => {
        const success = await verifyDebtRepaid(projectPath, actionId);
        setReport((prev) =>
          markActionStatus(
            prev,
            actionId,
            success
              ? 'repaid'
              : (prev?.actionList.find((a) => a.actionId === actionId)?.status ?? 'pending'),
          ),
        );
      });
    },
    [projectPath, setReport],
  );
  const handleDismiss = useCallback(
    async (actionId: string) => {
      await dismissDebtAction(projectPath, actionId);
      setReport((prev) => markActionStatus(prev, actionId, 'dismissed'));
    },
    [projectPath, setReport],
  );
  return { planLoading, verifyLoading, handlePlan, handleVerify, handleDismiss };
}

function useTechDebtRun(projectPath: string): {
  loading: boolean;
  progress: number;
  progressMessage: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  /** 取消当前任务（用户点「停止」）：主进程立刻让等待方返回，UI 不等执行器收尾 */
  cancel: () => void;
  /** 已发出取消、等任务中心确认（按钮显示「停止中…」并禁用） */
  stopping: boolean;
  queued: boolean;
  /** 排队位置（1 起；仅 queued 时有值） */
  queuePosition?: number;
  report: TechDebtReportData | null;
  planLoading: string | null;
  verifyLoading: string | null;
  handleScan: () => Promise<void>;
  handlePlan: (
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  handleVerify: (actionId: string) => Promise<void>;
  handleDismiss: (actionId: string) => Promise<void>;
} {
  const [report, setReport] = useState<TechDebtReportData | null>(null);
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } = useTaskRun('techdebt', projectPath);
  const { planLoading, verifyLoading, handlePlan, handleVerify, handleDismiss } =
    useTechDebtActions(projectPath, setReport);

  // 共用骨架：成功回填报告、取消保留已有报告、真故障清空（与 security/performance/dependency 同一实现）
  // 显式传 T：scanTechDebt 出错时自身返回 null（不回填），与 setReport 的 SetStateAction 推断冲突
  const { handleScan } = useRunWithReport<TechDebtReportData | null>(
    projectPath,
    scanTechDebt,
    setReport,
  );

  return {
    loading,
    progress,
    progressMessage: statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    report,
    planLoading,
    verifyLoading,
    handleScan,
    handlePlan,
    handleVerify,
    handleDismiss,
  };
}

function useTechDebtCopyToAi(projectPath: string): {
  copyToAi: (action: TechDebtReportData['actionList'][number]) => void;
  copyAllToAi: (actions: TechDebtReportData['actionList']) => void;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    (action: TechDebtReportData['actionList'][number]) => {
      copyIssuesToAi(projectPath, toast, [
        {
          source: t('page.techdebt.source'),
          ruleId: action.actionId,
          message: `${action.module} — ${t(`page.techdebt.category.${action.category}`)} (ROI: ${action.roi})`,
          domain: 'techdebt',
        },
      ]);
    },
    [projectPath, toast],
  );

  const copyAllToAi = useCallback(
    (actions: TechDebtReportData['actionList']) => {
      if (actions.length === 0) return;
      copyIssuesToAi(
        projectPath,
        toast,
        actions.map((action) => ({
          source: t('page.techdebt.source'),
          ruleId: action.actionId,
          message: `${action.module} — ${t(`page.techdebt.category.${action.category}`)} (ROI: ${action.roi})`,
        })),
      );
    },
    [projectPath, toast],
  );

  return { copyToAi, copyAllToAi };
}

export function useTechDebtPage(projectPath: string) {
  const debtRun = useTechDebtRun(projectPath);
  const { copyToAi, copyAllToAi } = useTechDebtCopyToAi(projectPath);

  return { ...debtRun, copyToAi, copyAllToAi };
}
