/**
 * 技术债 ROI 排序引擎（tech-debt/dashboard.ts）。
 *
 * 规格来源：`00-项目文档/00-总览/08-商业化P0实现规格.md` 附 D。
 * 纯函数：输入 issues + 模块热度 + 对外接口清单，输出 TechDebtSnapshot。
 * 不执行 git、不碰 DB、不执行项目代码（P0-2 禁令合规）。
 */
import type {
  CategoryDebt,
  DebtAction,
  DebtActionStatus,
  DebtCategory,
  DebtIssueInput,
  ModuleDebt,
  TechDebtInput,
  TechDebtSnapshot,
} from './types';

const BACKSLASH_RE = /\\/g;
const DOT_SLASH_RE = /^\.\//;

/** 单条 Issue 按 severity 的利息权重（安全 > 架构 > 质量 > 重复 的近似：error > warning > info） */
const SEVERITY_WEIGHT: Record<'error' | 'warning' | 'info', number> = {
  error: 3,
  warning: 2,
  info: 1,
};

/** 本金（人天粗估）：按 Issue 类别查表。UI 需标注「估算」。 */
const PRINCIPAL_DAYS: Record<DebtCategory, number> = {
  security: 2,
  quality: 0.5,
  architecture: 3,
  duplication: 1,
  dependency: 0.5,
};

/** 债务类别 → 利息权重（同类别聚合时按比例放大，体现"类型重要性"） */
const CATEGORY_WEIGHT: Record<DebtCategory, number> = {
  security: 3,
  architecture: 2,
  quality: 1.5,
  duplication: 1,
  dependency: 1.5,
};

/** 既有 IssueCategory（8 项）→ 债务类别（5 项）映射。无法映射的归 quality。 */
export function mapToDebtCategory(category: string): DebtCategory {
  switch (category) {
    case 'security':
      return 'security';
    case 'architecture':
      return 'architecture';
    case 'performance':
    case 'documentation':
    case 'test':
    case 'quality':
      return 'quality';
    case 'dependency':
      return 'dependency';
    case 'refactoring':
      return 'duplication';
    default:
      return 'quality';
  }
}

/** 模块热度因子：commitCount 线性映射到 1.0-3.0（0 次 → 1.0，≥50 次 → 3.0） */
function hotnessFactor(commitCount: number): number {
  if (commitCount <= 0) return 1;
  return Math.min(3, 1 + (commitCount / 50) * 2);
}

/** 密度系数：同模块同类别 issue 数量 → 1.0-2.0（1 条 → 1.0，≥10 条 → 2.0，扎堆一次修一片优先） */
function densityFactor(count: number): number {
  if (count <= 1) return 1;
  return Math.min(2, 1 + count / 10);
}

/** 模块提取：取 issue.file 的顶层目录 + 文件名（相对路径，无 file 归 '(root)'） */
export function moduleOf(file: string): string {
  const cleaned = file.replace(BACKSLASH_RE, '/').replace(DOT_SLASH_RE, '');
  if (!cleaned) return '(root)';
  return cleaned;
}

/** 计算安全敞口因子：文件出现在对外接口清单 → 1.5，否则 1.0 */
function exposureFactor(file: string, exposedFiles: Set<string>): number {
  if (!exposedFiles.size) return 1;
  const normalized = file.replace(BACKSLASH_RE, '/');
  return exposedFiles.has(normalized) ? 1.5 : 1;
}

/** 聚合单条 action：同模块同类别 issues 归并 */
function buildActions(
  issues: DebtIssueInput[],
  hotnessByModule: Map<string, number>,
  exposedFiles: Set<string>,
): DebtAction[] {
  const groups = groupIssuesByModule(issues);
  const actions: DebtAction[] = [];
  for (const [key, group] of groups) {
    actions.push(buildActionFromGroup(key, group, hotnessByModule, exposedFiles));
  }
  markRecommended(actions);
  return actions;
}

function groupIssuesByModule(
  issues: DebtIssueInput[],
): Map<string, { issues: DebtIssueInput[]; category: DebtCategory }> {
  const groups = new Map<string, { issues: DebtIssueInput[]; category: DebtCategory }>();
  for (const issue of issues) {
    const module = moduleOf(issue.file);
    const category = mapToDebtCategory(issue.category);
    const key = `${module}::${category}`;
    const existing = groups.get(key);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(key, { issues: [issue], category });
    }
  }
  return groups;
}

function buildActionFromGroup(
  key: string,
  group: { issues: DebtIssueInput[]; category: DebtCategory },
  hotnessByModule: Map<string, number>,
  exposedFiles: Set<string>,
): DebtAction {
  const { issues: groupIssues, category } = group;
  const module = key.split('::')[0];
  const severitySum = groupIssues.reduce((acc, i) => acc + SEVERITY_WEIGHT[i.severity], 0);
  const avgSeverity = severitySum / groupIssues.length;
  const severityFactor = avgSeverity;
  const hotnessFactorValue = hotnessFactor(hotnessByModule.get(module) ?? 0);
  const densityFactorValue = densityFactor(groupIssues.length);
  const maxExposure = Math.max(...groupIssues.map((i) => exposureFactor(i.file, exposedFiles)), 1);
  const exposureFactorValue = maxExposure;

  const interestScore =
    severityFactor *
    hotnessFactorValue *
    densityFactorValue *
    exposureFactorValue *
    CATEGORY_WEIGHT[category];

  const principalEstimate = PRINCIPAL_DAYS[category] * groupIssues.length;
  const roi = principalEstimate > 0 ? interestScore / principalEstimate : interestScore;

  return {
    actionId: `td-${category}-${Buffer.from(module).toString('base64url').slice(0, 12)}`,
    issueIds: groupIssues.map((i) => i.id),
    module,
    category,
    interestScore: round2(interestScore),
    interestBreakdown: {
      severityFactor: round2(severityFactor),
      hotnessFactor: round2(hotnessFactorValue),
      densityFactor: round2(densityFactorValue),
      exposureFactor: round2(exposureFactorValue),
    },
    principalEstimate,
    roi: round2(roi),
    recommended: false,
    status: 'pending',
  };
}

function markRecommended(actions: DebtAction[]): void {
  actions.sort((a, b) => b.roi - a.roi);
  const topCount = Math.min(10, actions.length);
  for (let i = 0; i < topCount; i += 1) {
    actions[i].recommended = true;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 构建技术债快照（主入口） */
export function buildTechDebtDashboard(input: TechDebtInput): TechDebtSnapshot {
  const { projectId, issues, moduleHotness, exposedFiles = [] } = input;
  const hotnessByModule = new Map(moduleHotness.map((m) => [moduleOf(m.module), m.commitCount]));
  const exposedSet = new Set(exposedFiles.map((f) => f.replace(/\\/g, '/')));

  const actions = buildActions(issues, hotnessByModule, exposedSet);
  const { byModule, totalInterest } = aggregateByModule(actions, hotnessByModule);
  const byCategory = aggregateByCategory(actions, totalInterest);
  const debtIndex = computeDebtIndex(issues);

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    debtIndex,
    trend: { period: 'week', delta: 0 },
    byModule,
    byCategory,
    actionList: actions,
  };
}

function aggregateByModule(
  actions: DebtAction[],
  hotnessByModule: Map<string, number>,
): { byModule: ModuleDebt[]; totalInterest: number } {
  const moduleMap = new Map<string, { interest: number; hotness: number }>();
  for (const action of actions) {
    const cur = moduleMap.get(action.module) ?? { interest: 0, hotness: 0 };
    cur.interest += action.interestScore;
    cur.hotness = Math.max(cur.hotness, hotnessByModule.get(action.module) ?? 0);
    moduleMap.set(action.module, cur);
  }
  const totalInterest = moduleMap.size
    ? [...moduleMap.values()].reduce((acc, m) => acc + m.interest, 0)
    : 0;
  const byModule: ModuleDebt[] = Array.from(
    moduleMap.entries(),
    ([module, { interest, hotness }]) => ({
      module,
      debtShare: totalInterest > 0 ? round2(interest / totalInterest) : 0,
      hotness,
      interestTotal: round2(interest),
    }),
  ).sort((a, b) => b.interestTotal - a.interestTotal);
  return { byModule, totalInterest };
}

function aggregateByCategory(actions: DebtAction[], totalInterest: number): CategoryDebt[] {
  const categoryMap = new Map<DebtCategory, { count: number; interest: number }>();
  for (const action of actions) {
    const cur = categoryMap.get(action.category) ?? { count: 0, interest: 0 };
    cur.count += action.issueIds.length;
    cur.interest += action.interestScore;
    categoryMap.set(action.category, cur);
  }
  return Array.from(categoryMap.entries(), ([category, { count, interest }]) => ({
    category,
    count,
    weight: totalInterest > 0 ? round2(interest / totalInterest) : 0,
  })).sort((a, b) => b.weight - a.weight);
}

/** 债务指数：issues 加权和 → 0-100（0=无债，100=满债）。与健康评分同源互补（评分越高越健康，债务指数越高越重）。 */
export function computeDebtIndex(issues: DebtIssueInput[]): number {
  if (issues.length === 0) return 0;
  const weighted = issues.reduce((acc, i) => {
    const severity = SEVERITY_WEIGHT[i.severity];
    const category = CATEGORY_WEIGHT[mapToDebtCategory(i.category)];
    return acc + severity * category;
  }, 0);
  return Math.min(100, Math.round((weighted / 90) * 100));
}

export function mergeActionStatuses(
  actions: DebtAction[],
  persisted: ReadonlyArray<{ actionId: string; status: DebtActionStatus }>,
): DebtAction[] {
  const statusById = new Map(persisted.map((p) => [p.actionId, p.status]));
  return actions.map((a) => {
    const status = statusById.get(a.actionId);
    return status ? { ...a, status } : a;
  });
}

export function computeTrendDelta(current: number, previous: number | null): number {
  return previous === null ? 0 : current - previous;
}
