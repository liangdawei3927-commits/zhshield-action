import type { ToolId, Issue, IssueCategory, DimensionScore } from './types';

/**
 * 工具问题 → 评分维度映射 (文档 11.2 节)
 *
 * 每个工具发现的问题按 category 归属到评分维度。
 * 开源工具负责扫描，自研模块通过此映射将结果转化为健康评分。
 */
const TOOL_DIMENSION_MAP: Record<ToolId, IssueCategory[]> = {
  eslint: ['quality', 'performance', 'documentation'],
  tsc: ['quality'],
  semgrep: ['security'],
  trivy: ['security', 'dependency'],
  grype: ['security', 'dependency'],
  gitleaks: ['security'],
  ort: ['dependency', 'documentation'],
  depcheck: ['dependency', 'quality'],
  'dep-cruiser': ['architecture'],
  jscpd: ['quality'],
  'ts-prune': ['quality'],
};

export function getToolDimensions(toolId: ToolId): IssueCategory[] {
  return TOOL_DIMENSION_MAP[toolId] ?? ['quality'];
}

const CATEGORY_WEIGHTS: Record<IssueCategory, number> = {
  architecture: 0.20,
  security: 0.25,
  quality: 0.20,
  performance: 0.15,
  documentation: 0.05,
  test: 0.10,
  dependency: 0.05,
  refactoring: 0.05,
};

/** 将问题按类别分组 */
function groupIssuesByCategory(issues: Issue[]): Map<IssueCategory, Issue[]> {
  const dimMap = new Map<IssueCategory, Issue[]>();
  for (const issue of issues) {
    if (!dimMap.has(issue.category)) {
      dimMap.set(issue.category, []);
    }
    dimMap.get(issue.category)!.push(issue);
  }
  return dimMap;
}

/** 按严重程度折算单维度得分 */
function computeDimensionScore(category: IssueCategory, catIssues: Issue[]): DimensionScore {
  const weight = CATEGORY_WEIGHTS[category] ?? 0.05;
  const errorCount = catIssues.filter((i) => i.severity === 'error').length;
  const warnCount = catIssues.filter((i) => i.severity === 'warning').length;
  const infoCount = catIssues.filter((i) => i.severity === 'info').length;

  const raw = Math.max(0, 100 - errorCount * 15 - warnCount * 5 - infoCount * 1);
  const score = Math.round(raw * 100) / 100;

  return {
    name: category,
    weight,
    score,
    issues: catIssues.length,
  };
}

export function mapIssuesToDimensions(issues: Issue[], _toolId?: ToolId): DimensionScore[] {
  const dimMap = groupIssuesByCategory(issues);

  const scores: DimensionScore[] = [];
  for (const [category, catIssues] of dimMap) {
    scores.push(computeDimensionScore(category, catIssues));
  }

  return scores;
}

export function computeOverallScore(dimensions: DimensionScore[]): number {
  if (dimensions.length === 0) return 100;
  const weighted = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  return totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : 100;
}

export function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}
