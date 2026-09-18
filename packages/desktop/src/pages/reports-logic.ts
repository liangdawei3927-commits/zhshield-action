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
