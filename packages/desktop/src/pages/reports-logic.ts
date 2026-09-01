import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { getProfile, getScore, getScoreHistory, runPipeline } from '../services/engineApi';
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

/** 报告页全部状态与副作用：历史加载、生成新报告 */
export function useReportsPage(projectPath: string) {
  const { data, loading, load } = useScoreHistory(projectPath);

  const handleNewReport = useCallback(async () => {
    await runPipeline(projectPath, { dryRun: false, sop: true });
    await load();
  }, [projectPath, load]);

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
