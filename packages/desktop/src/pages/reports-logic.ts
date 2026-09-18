import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import {
  getProfile,
  getScore,
  getScoreHistory,
  generateReportSummary,
} from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import { collectModuleScores, type ModuleScoreView } from './module-scores-logic';
import type { HealthScoreData } from '../types/electron';

/** 预别名类型 — 避免 .tsx 中出现泛型尖括号（会被 JSX 深度检测误判） */
export type HealthScoreRow = Readonly<HealthScoreData>;

export function getScoreColor(score: number) {
  if (score >= 90) return 'rgb(var(--zh-success))';
  if (score >= 75) return 'rgb(var(--zh-info))';
  if (score >= 60) return 'rgb(var(--zh-warning))';
  return 'rgb(var(--zh-danger))';
}

export function getScoreLabel(score: number) {
  if (score >= 90) return t('page.reports.scoreLabel.excellent');
  if (score >= 75) return t('page.reports.scoreLabel.good');
  if (score >= 60) return t('page.reports.scoreLabel.needsImprovement');
  return t('page.reports.scoreLabel.danger');
}

export function dimensionName(dimKey: string, tr: typeof t = t): string {
  const key = `page.reports.dimension.${dimKey}`;
  const name = tr(key);
  return name === key ? dimKey : name;
}

export function gradeLabel(grade: string, tr: typeof t = t): string {
  const key = `page.reports.grade.${grade}`;
  const label = tr(key);
  return label === key ? grade : label;
}

/**
 * 总分新鲜度阈值：与主进程 `DASHBOARD_FRESH_MS`（`electron/ipc/engines.ts`）同口径（24h）。
 *
 * 二者是**两个独立常量**（渲染进程一个、主进程一个），靠
 * `src/__tests__/freshness-parity.test.ts` 的结构断言保持数值一致 ——
 * 该用例若红，说明两侧已漂移，不要各自改数字，而要一起改。
 *
 * 总分是**对上一次检查结果的汇总**，不是实时值 —— 报告中心与体检页都只读各域最近一次
 * 落盘结果（guard 报告记录 + `.zhshield/diagnostics/domains/inspect.json` +
 * `dashboard-state.json`），不会为了出分而重跑任何检查。因此必须把「这份分有多旧」
 * 显式告诉用户，否则陈旧分会被当成当前状态（T14 落分口径统一）。
 */
export const SCORE_FRESH_MS = 24 * 60 * 60 * 1000;

export interface ScoreFreshness {
  /** true = 数据超过阈值，总分只能代表「截至那一时刻」的状态 */
  stale: boolean;
  /** 距今天数取整（小时）；时间戳不可解析时为 0 并同样判 stale */
  ageHours: number;
}

/** 计算总分的数据新鲜度（纯函数，便于单测；不依赖 React / Electron） */
export function scoreFreshness(timestamp: string, now: number = Date.now()): ScoreFreshness {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return { stale: true, ageHours: 0 };
  const ageMs = Math.max(0, now - ts);
  return { stale: ageMs > SCORE_FRESH_MS, ageHours: Math.floor(ageMs / 3_600_000) };
}

/** 历史分数数据加载：数据状态 + 拉取 */
function useScoreHistoryData(projectPath: string): {
  data: HealthScoreData[];
  fetchHistory: () => Promise<void>;
} {
  const [data, setData] = useState<HealthScoreData[]>([]);
  const fetchHistory = useCallback(async () => {
    setData(await getScoreHistory(projectPath));
  }, [projectPath]);
  return { data, fetchHistory };
}

/** 报告页历史分数加载：加载状态 + 自动加载 */
function useScoreHistory(projectPath: string): {
  data: HealthScoreData[];
  loading: boolean;
  load: () => Promise<void>;
} {
  const { data, fetchHistory } = useScoreHistoryData(projectPath);
  const [loading, setLoading] = useState(true);
  const load = useScoreHistoryLoader(fetchHistory, setLoading);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, load };
}

function useScoreHistoryLoader(
  fetchHistory: () => Promise<void>,
  setLoading: (v: boolean) => void,
): () => Promise<void> {
  return useCallback(async () => {
    setLoading(true);
    try {
      await fetchHistory();
    } finally {
      setLoading(false);
    }
  }, [fetchHistory]);
}

/**
 * 报告页全部状态与副作用：历史加载、汇总生成报告。
 *
 * 「汇总生成报告」= 只读汇总，不是「跑一遍检查」：
 * 读各域（guard/inspect/…）最新落盘结果 → 统一维度加权 → 落库一条新评分。
 * 触发权属于各治理域自己（在各自页面点扫描）；报告中心只负责把已有结果汇总成总分，
 * 因此点按钮不会再在任务中心冒出 guard/inspect 任务。
 * 各域都没跑过时后端返回 null —— 明确提示用户「先运行检查」，
 * 而不是写一条 0 分污染历史（未检测 ≠ 0 分）。
 */
export function useReportsPage(projectPath: string) {
  const { data, loading, load } = useScoreHistory(projectPath);
  const { toast } = useToast();

  const handleNewReport = useCallback(async () => {
    const summary = await generateReportSummary(projectPath);
    if (!summary) {
      toast(t('page.reports.noResults'), 'warning');
      return;
    }
    await load();
    toast(t('page.reports.summaryDone', { score: Math.round(summary.score) }), 'success');
  }, [projectPath, load, toast]);

  return { data, loading, handleNewReport };
}

/** 报告页模块级评分：拉取项目画像子模块 + 各模块评分，汇集为视图；无子模块时返回空 */
export function useModuleScores(projectPath: string) {
  const [modules, setModules] = useState<ModuleScoreView[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const profile = await getProfile(projectPath);
      if (cancelled || !profile?.modules?.length) {
        if (!cancelled) setModules([]);
        setLoading(false);
        return;
      }
      const views = await collectModuleScores(profile.modules, getScore);
      if (!cancelled) setModules(views);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return { modules, loading };
}
