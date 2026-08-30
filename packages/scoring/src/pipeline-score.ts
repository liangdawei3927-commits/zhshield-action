import type { DimensionScore } from './types';
import { DimensionMapper } from './dimension-mapper';
import type { ScoringProjectProfile } from '@zh/fingerprint';
import { resolveProfileScoring, applyWeightDeltas, applyDisabledDimensions } from './profile-scoring-resolver';

/** guard 检查的最小结构 — 与 @zh/guard CheckResult 字段兼容，避免包间依赖 */
export interface GuardCheckLike {
  severity: 'error' | 'warning' | 'info';
  status: 'passed' | 'failed' | 'error' | 'warning';
  blocking: boolean;
}

/** guard 报告最小结构 — 与 @zh/guard GuardReport 字段兼容 */
export interface GuardReportLike {
  results: GuardCheckLike[];
}

/** inspect 问题的最小结构 — 与 @zh/inspect Issue 字段兼容 */
export interface InspectIssueLike {
  severity: 'error' | 'warning' | 'info';
  category: string;
}

/** inspect 报告最小结构 — 与 @zh/inspect InspectionReport 字段兼容 */
export interface InspectionReportLike {
  issues: InspectIssueLike[];
}

const DIMENSION_CATEGORIES: Record<string, string[]> = {
  security: ['security'],
  quality: ['performance', 'quality'],
  architecture: ['architecture', 'refactoring'],
  dependencies: ['test', 'dependency'],
  documentation: ['documentation'],
};

const ISSUE_PENALTY: Record<'error' | 'warning' | 'info', number> = {
  error: 8,
  warning: 4,
  info: 1,
};

function penaltyForIssues(issues: InspectIssueLike[]): number {
  return issues.reduce((sum, issue) => sum + ISSUE_PENALTY[issue.severity], 0);
}

/** guard 失败/警告计入 security 维度的扣分 */
function guardPenalty(results: GuardCheckLike[]): number {
  return results.reduce((sum, r) => {
    if (r.status === 'failed' || r.status === 'error' || r.blocking) return sum + 8;
    if (r.status === 'warning') return sum + 4;
    return sum;
  }, 0);
}

/** guard 中非 passed 的结果数（与 guardPenalty 的判定口径一致） */
function guardIssueCount(results: GuardCheckLike[]): number {
  return results.reduce((sum, r) => sum + (r.status === 'passed' && !r.blocking ? 0 : 1), 0);
}

/**
 * 由 guard + inspect 报告构建健康维度分（权重和为 1）。
 * 每个维度满分 100：error 扣 8、warning 扣 4、info 扣 1，下限 0；
 * security 维度额外计入 guard 的失败/阻塞检查。
 *
 * 权重来自项目级评分配置（默认配置 + `.zhshield/scoring.yml` 覆盖，见
 * {@link resolveScoringConfig}）；无覆盖文件时与内置默认权重一致。
 *
 * @param projectRoot 项目根目录，缺省为 process.cwd()；传入可显式指定被扫描项目
 * @param profile 项目画像（来自 @zh/fingerprint 的评分契约）；传入时按项目类型自动微调维度权重，
 *   不传则走默认配置（向后兼容）。profile 增量在项目级 .zhshield/scoring.yml 之上叠加。
 * @throws {ProjectScoringConfigError} 项目覆盖文件存在但内容非法时（fail-fast）
 */
export function buildHealthDimensions(
  guard: GuardReportLike,
  inspect: InspectionReportLike,
  projectRoot?: string,
  profile?: ScoringProjectProfile | null,
): DimensionScore[] {
  const dimensionMapper = new DimensionMapper(undefined, projectRoot);
  const weightMap = resolveWeightMap(profile, dimensionMapper);
  return Object.entries(DIMENSION_CATEGORIES).map(([name, categories]) =>
    scoreDimension(name, categories, weightMap, guard, inspect),
  );
}

/** 画像驱动权重适配：增量叠加 + 不适用维度剔除 + 归一化，向后兼容 */
function resolveWeightMap(
  profile: ScoringProjectProfile | null | undefined,
  dimensionMapper: DimensionMapper,
): Record<string, number> {
  let weightMap = dimensionMapper.getWeightMap();
  if (profile) {
    const overrides = resolveProfileScoring(profile);
    if (overrides.weightDeltas) {
      weightMap = applyWeightDeltas(weightMap, overrides.weightDeltas);
    }
    if (overrides.disabledDimensions?.length) {
      weightMap = applyDisabledDimensions(weightMap, overrides.disabledDimensions);
    }
  }
  return weightMap;
}

function scoreDimension(
  name: string,
  categories: string[],
  weightMap: Record<string, number>,
  guard: GuardReportLike,
  inspect: InspectionReportLike,
): DimensionScore {
  const weight = weightMap[name] ?? 0;
  const matched = inspect.issues.filter((issue) => categories.includes(issue.category));
  const issues = matched.length + (name === 'security' ? guardIssueCount(guard.results) : 0);
  let penalty = penaltyForIssues(matched);
  if (name === 'security') penalty += guardPenalty(guard.results);

  return {
    name,
    weight,
    score: Math.max(0, Math.round((100 - penalty) * 10) / 10),
    issues,
  };
}
