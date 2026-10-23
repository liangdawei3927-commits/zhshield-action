import path from 'node:path';
import type { DimensionScore, HealthScore } from './types';
import type { GuardCheckLike, InspectIssueLike } from './pipeline-score';
import type { ScoringProjectProfile, ProjectType, ModuleProfile } from '@zh/fingerprint';
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

/**
 * 单个模块的评分输入：路径 + 画像（含类型）+ 该模块自身的 guard/inspect 报告。
 *
 * 🔴 `path` 与 `id` 是两种不同语义，不可合并（10-24 教训）：
 * - `path` = 画像给出的**相对**项目根路径（如 `packages/ui`），用于 findings 前缀分桶与界面展示；
 * - `id`   = **绝对**路径，用作 `scores.project_id` 落库键与项目级评分配置的读盘基址。
 *
 * 曾把 `path` 直接当落库键：`packages/ui` 不是全局唯一标识，任意两个 monorepo 只要有同名
 * 子包就会读写同一行记录，历史曲线互相污染（实测 tianyin 与内层 monorepo 的记录时间戳逐条对撞）。
 */
export interface ModuleScoreInput {
  /** 相对项目根的模块路径（画像原值），仅用于分桶匹配与展示 */
  path: string;
  /** 绝对路径身份键（落库 project_id / 读项目级评分配置的基址） */
  id: string;
  profile: ScoringProjectProfile;
  guard: ModuleGuardInput;
  inspect: ModuleInspectInput;
}

/** 单模块评分卡 */
export interface ModuleScorecard {
  /** 相对项目根的模块路径（展示用） */
  path: string;
  /** 绝对路径身份键（落库用，绝不与 path 混用） */
  id: string;
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

/**
 * ModuleProfile → 最小 ScoringProjectProfile（供 buildHealthDimensions 按模块类型取权重）。
 *
 * `absPath` 必须是绝对路径：它会被 `DimensionMapper` 用来读该模块的项目级评分配置，
 * 传相对路径会从进程 CWD 解析、静默降级成默认配置。
 */
function moduleToProfile(m: ModuleProfile, absPath: string): ScoringProjectProfile {
  return {
    version: '1.0.0',
    projectRoot: absPath,
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
 * 把画像给出的模块路径解析为绝对身份键。
 * `path.resolve` 天然兼容两种情况：相对路径按项目根拼接，已是绝对路径则原样返回。
 */
export function resolveModuleId(projectRoot: string, modulePath: string): string {
  if (!modulePath) return path.resolve(projectRoot);
  return path.resolve(projectRoot, modulePath);
}

/**
 * 按模块目录把 findings 分桶到各子模块；未命中任何子模块的文件归入根级兜底模块。
 * 匹配规则：file 等于模块路径或以 `模块路径/` 开头，取最长前缀匹配。
 * 匹配用的是画像原值 `path`（相对路径），落库键用解析后的 `id`（绝对路径）。
 */
export function bucketFindingsByModule(
  root: ScoringProjectProfile,
  guard: ModuleGuardInput,
  inspect: ModuleInspectInput,
): ModuleScoreInput[] {
  const modules = root.modules ?? [];
  const cards: ModuleScoreInput[] = modules.map((m) => {
    const id = resolveModuleId(root.projectRoot, m.path);
    return {
      path: m.path,
      id,
      profile: moduleToProfile(m, id),
      guard: { results: [] },
      inspect: { issues: [] },
    };
  });

  const rootCard: ModuleScoreInput = {
    path: root.projectRoot,
    id: resolveModuleId(root.projectRoot, root.projectRoot),
    profile: moduleToProfile(
      {
        path: root.projectRoot,
        language: root.language,
        framework: root.framework,
        type: root.type,
      },
      resolveModuleId(root.projectRoot, root.projectRoot),
    ),
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
    const dims = buildHealthDimensions({
      guard: m.guard,
      inspect: m.inspect,
      projectRoot: m.id,
      profile: m.profile,
    });
    // 落库键必须是绝对路径 id：用 path（相对）会把不同项目的同名子包写进同一行
    const res = new ScoringEngine().calculate(m.id, dims);
    return {
      path: m.path,
      id: m.id,
      type: m.profile.type,
      overall: res.overall,
      grade: res.grade,
      dimensions: dims,
    };
  });
  const overall = cards.length
    ? Math.round((cards.reduce((s, c) => s + c.overall, 0) / cards.length) * 100) / 100
    : 0;
  return { modules: cards, overall, grade: gradeOf(overall) };
}

/** 组合分桶 + 逐模块评分：直接对准「根画像 + 原始 guard/inspect findings」给出模块级聚合分 */
export function scoreProjectByModules(
  root: ScoringProjectProfile,
  guard: ModuleGuardInput,
  inspect: ModuleInspectInput,
): ProjectScoreAggregate {
  return scoreProjectModules(bucketFindingsByModule(root, guard, inspect));
}
