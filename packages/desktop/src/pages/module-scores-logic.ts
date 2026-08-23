import type { HealthScoreData, ModuleProfileData } from '../types/electron';

/** 模块级评分视图（供报告页渲染；score 为 null 表示该模块暂无评分） */
export interface ModuleScoreView {
  path: string;
  name: string;
  type: string;
  score: number | null;
  summary: string | null;
}

/**
 * 按模块路径拉取各模块评分并汇成视图，按 path 排序。
 * getScore 注入以便单测（真实场景传 engineApi.getScore）。
 */
export async function collectModuleScores(
  modules: ModuleProfileData[],
  getScore: (path: string) => Promise<HealthScoreData | null>,
): Promise<ModuleScoreView[]> {
  const views = await Promise.all(
    modules.map(async (m) => {
      const s = await getScore(m.path);
      return {
        path: m.path,
        name: m.path.split(/[\\/]/).pop() || m.path,
        type: m.type,
        score: s?.score ?? null,
        summary: s?.summary ?? null,
      };
    }),
  );
  return views.sort((a, b) => a.path.localeCompare(b.path));
}
