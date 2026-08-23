import type { DimensionScore, HealthScore } from './types';
import type { GuardCheckLike, InspectIssueLike } from './pipeline-score';
import type { ProjectProfile, ProjectType, ModuleProfile } from '@zh/profiler';
import { buildHealthDimensions } from './pipeline-score';
import { ScoringEngine } from './engine';

/** 单模块的 guard 输入（在 GuardCheckLike 基础上保留 file 以便按模块分桶） */
export interface ModuleGuardInput {
  results: Array<GuardCheckLike & { file?: string }>;
}

/** 单模块的 inspect 输入（在 InspectIssueLike 基础上保留 file 以便按模块分桶） */
export interface ModuleInspectInput {
  issues: Array<InspectIssueLike & { file?: string }>;
}

/** 单个模块的评分输入：路径 + 画像（含类型）+ 该模块自身的 guard/inspect 报告 */
export interface ModuleScoreInput {
  path: string;
  profile: ProjectProfile;
  guard: ModuleGuardInput;
  inspect: ModuleInspectInput;
}

/** 单模块评分卡 */
export interface ModuleScorecard {
  path: string;
  type: ProjectType;
  overall: number;
  grade: HealthScore['grade'];
  dimensions: DimensionScore[];
}

/** 项目级聚合评分（monorepo：各模块独立评分后聚合） */
export interface ProjectScoreAggregate {
  modules: ModuleScorecard[];
  overall: number;
  grade: HealthScore['grade'];
}

/** ModuleProfile → 最小 ProjectProfile（供 buildHealthDimensions 按模块类型取权重） */
function moduleToProfile(m: ModuleProfile): ProjectProfile {
  return {
    version: '1.0.0',
    projectRoot: m.path,
    language: m.language,
    secondaryLanguages: [],
    framework: m.framework,
    type: m.type,
    runtime: 'unknown',
    packageManager: 'unknown',
    isMonorepo: false,
    detectedFiles: [],
    confidence: 1,
    detectedAt: new Date(),
    signals: [],
  };
}

function gradeOf(score: number): HealthScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

/**
 * 按模块目录把 findings 分桶到各子模块；未命中任何子模块的文件归入根级兜底模块。
 * 匹配规则：file 等于模块路径或以 `模块路径/` 开头，取最长前缀匹配。
 */
export function bucketFindingsByModule(
  root: ProjectProfile,
  guard: ModuleGuardInput,
  inspect: ModuleInspectInput,
): ModuleScoreInput[] {
  const modules = root.modules ?? [];
  const cards: ModuleScoreInput[] = modules.map((m) => ({
    path: m.path,
    profile: moduleToProfile(m),
    guard: { results: [] },
    inspect: { issues: [] },
  }));

  const rootCard: ModuleScoreInput = {
    path: root.projectRoot,
    profile: moduleToProfile({ path: root.projectRoot, language: root.language, framework: root.framework, type: root.type }),
    guard: { results: [] },
    inspect: { issues: [] },
  };
  const all = [...cards, rootCard];

  const match = (file?: string): ModuleScoreInput => {
    if (!file) return rootCard;
    let best: ModuleScoreInput | null = null;
    let bestLen = -1;
    for (const c of cards) {
      if (file === c.path || file.startsWith(c.path + '/')) {
        if (c.path.length > bestLen) {
          best = c;
          bestLen = c.path.length;
        }
      }
    }
    return best ?? rootCard;
  };

  for (const r of guard.results) match(r.file).guard.results.push(r);
  for (const i of inspect.issues) match(i.file).inspect.issues.push(i);
  return all;
}

/**
 * 逐个模块评分（沿用各模块类型对应的权重/适用性），再等权聚合为项目整体分。
 * 空输入返回整体分 0；单模块时退化为该模块自身评分（向后兼容非 monorepo）。
 */
export function scoreProjectModules(modules: ModuleScoreInput[]): ProjectScoreAggregate {
  const cards = modules.map((m) => {
    const dims = buildHealthDimensions(m.guard, m.inspect, m.path, m.profile);
    const res = new ScoringEngine().calculate(m.path, dims);
    return { path: m.path, type: m.profile.type, overall: res.overall, grade: res.grade, dimensions: dims };
  });
  const overall = cards.length
    ? Math.round((cards.reduce((s, c) => s + c.overall, 0) / cards.length) * 100) / 100
    : 0;
  return { modules: cards, overall, grade: gradeOf(overall) };
}
