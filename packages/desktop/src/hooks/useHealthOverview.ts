import { useCallback, useEffect, useState } from 'react';
import { getHealthOverview } from '../services/engineApi';
import { useProjectSettledTick } from '../task-store';
import type { HealthOverviewData } from '../types/electron';

/**
 * 报告中心「评分总览」的实时数据源。
 *
 * 为什么总览不能继续读历史汇总记录（2026-10-24 P0）：
 * 汇总记录是「上次汇总那一刻」的时点快照，而分类页是打开页面时的实时重算。
 * 两条链不同源 ⇒ 卡片显示 100 分、点进去看到 92.9 是必然发生的（用户实测）。
 * 本 hook 走 `engine:getHealthOverview`（十维一次取齐、与分类页同源、只读不落库），
 * 卡片上的分才与点进去看到的分是同一个数。
 *
 * 取不到（各域都没跑过 / IPC 不可用）时返回 null，由调用方回退到最近一次汇总记录
 * 并把「数据时间」标出来 —— 宁可显示一个带时间戳的旧值，也不显示一个来源不明的数。
 */
export function useHealthOverview(
  projectPath: string,
  refreshKey?: unknown,
): { overview: HealthOverviewData | null; loading: boolean; reload: () => Promise<void> } {
  const [overview, setOverview] = useState<HealthOverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await getHealthOverview(projectPath));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // P0-1：任意域任务落定 → 总览自动重拉（总览聚合全部维度，任一域跑完都该刷新）
  const settledTick = useProjectSettledTick(projectPath);

  useEffect(() => {
    void load();
  }, [load, refreshKey, settledTick]);

  return { overview, loading, reload: load };
}
