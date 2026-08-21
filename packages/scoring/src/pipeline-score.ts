import type { DimensionScore } from './types';

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

const DIMENSION_SPECS: { name: string; weight: number; categories: string[] }[] = [
  { name: 'security', weight: 0.3, categories: ['security'] },
  { name: 'architecture', weight: 0.2, categories: ['architecture', 'refactoring'] },
  { name: 'performance', weight: 0.15, categories: ['performance', 'quality'] },
  { name: 'documentation', weight: 0.15, categories: ['documentation'] },
  { name: 'testing', weight: 0.2, categories: ['test', 'dependency'] },
];

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
 */
export function buildHealthDimensions(
  guard: GuardReportLike,
  inspect: InspectionReportLike,
): DimensionScore[] {
  return DIMENSION_SPECS.map(({ name, weight, categories }) => {
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
  });
}
