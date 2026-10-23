import type { HealthScoreData, ModuleProfileData } from '../types/electron';

const PATH_SEP_RE = /[\\/]/;
/** 绝对路径判定（POSIX `/…` 或 Windows `X:\` / `X:/`） */
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

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
 *
 * 🔴 `path` 必须是**绝对路径**（主进程 `getProfile` 已解析）。相对路径（`packages/ui`）
 * 会命中另一个项目的同名子包记录 —— 跨项目串数据。这里宁可不查、显示「—」，
 * 也不能拿相对键去查，同时打日志让上游接缝问题暴露出来而不是被静默吞掉。
 */
export async function collectModuleScores(
  modules: ModuleProfileData[],
  getScore: (path: string) => Promise<HealthScoreData | null>,
): Promise<ModuleScoreView[]> {
  const views = await Promise.all(
    modules.map(async (m) => {
      const name = m.path.split(PATH_SEP_RE).pop() || m.path;
      if (!ABS_PATH_RE.test(m.path)) {
        console.warn(
          `[module-scores] 模块路径不是绝对路径，跳过查询以免跨项目串数据: ${m.path}`,
        );
        return { path: m.path, name, type: m.type, score: null, summary: null };
      }
      const s = await getScore(m.path);
      return {
        path: m.path,
        name,
        type: m.type,
        score: s?.score ?? null,
        summary: s?.summary ?? null,
      };
    }),
  );
  return views.sort((a, b) => a.path.localeCompare(b.path));
}
