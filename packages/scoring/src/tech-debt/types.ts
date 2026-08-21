/**
 * 技术债仪表盘（tech-debt）类型定义。
 *
 * 规格来源：`00-项目文档/00-总览/08-商业化P0实现规格.md` 附 D。
 * 核心模型：技术债 = 利息（持续代价）× 本金（修复成本）；建议排序 = 利息 ÷ 本金。
 *
 * 边界（D.1）：
 * - 本金是粗估（按问题类型查表的人天估算），UI 标注「估算」；
 * - 利息是启发式（四因子：severity × 热度 × 密度 × 安全敞口），构成可解释展示；
 * - 不执行项目代码：模块热度只读 git log（由调用方传入，引擎为纯函数）。
 */

/** 债务类别：与既有 IssueCategory 的映射关系见 buildCategoryWeight */
export type DebtCategory =
  | 'security'
  | 'quality'
  | 'architecture'
  | 'duplication'
  | 'dependency';

/** 债务动作状态：pending 未处理 → planned 已计划（门禁联动 allow-with-record）→ in-progress → repaid 已偿还 / dismissed 忽略 */
export type DebtActionStatus = 'pending' | 'planned' | 'in-progress' | 'repaid' | 'dismissed';

/** 模块级债务（热力图数据源） */
export interface ModuleDebt {
  /** 模块路径（相对项目根，如 src/services/auth.ts） */
  module: string;
  /** 占总债务比例 0-1（按 action 利息加权） */
  debtShare: number;
  /** 改动频率（近 90 天该模块被提交的次数） */
  hotness: number;
  /** 该模块债务利息合计 */
  interestTotal: number;
}

/** 类别级债务（占比条数据源） */
export interface CategoryDebt {
  category: DebtCategory;
  count: number;
  /** 该类别利息权重 0-1 */
  weight: number;
}

/** 单条偿还建议（同模块同类型聚合） */
export interface DebtAction {
  actionId: string;
  /** 关联 Issue id（同模块同类型聚合） */
  issueIds: string[];
  module: string;
  category: DebtCategory;
  /** 利息（四因子启发式，可展开解释） */
  interestScore: number;
  /** 利息构成（D.7 可解释验收） */
  interestBreakdown: {
    severityFactor: number;
    hotnessFactor: number;
    densityFactor: number;
    exposureFactor: number;
  };
  /** 本金（人天粗估，UI 标注估算） */
  principalEstimate: number;
  /** 排序指标 = interestScore / principalEstimate */
  roi: number;
  /** 是否进入 Top 建议 */
  recommended: boolean;
  status: DebtActionStatus;
}

/** 趋势快照 */
export interface TechDebtTrend {
  period: 'week' | 'month' | 'quarter';
  /** 与上一期相比的债务指数变化（正=恶化，负=改善） */
  delta: number;
}

/** 技术债快照（D.2 主数据结构） */
export interface TechDebtSnapshot {
  projectId: string;
  generatedAt: string;
  /** 债务指数 0-100（与健康评分同源互补：越接近 100 债务越重） */
  debtIndex: number;
  trend: TechDebtTrend;
  byModule: ModuleDebt[];
  byCategory: CategoryDebt[];
  actionList: DebtAction[];
}

/** 引擎输入：单条问题的债务评估所需字段（Issue 子集） */
export interface DebtIssueInput {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  file: string;
}

/** 引擎输入：模块热度（由调用方从 git log 统计得出，引擎不执行 git） */
export interface ModuleHotnessInput {
  module: string;
  /** 近 90 天提交次数 */
  commitCount: number;
}

/** 引擎输入：聚合构建入参 */
export interface TechDebtInput {
  projectId: string;
  issues: DebtIssueInput[];
  /** 模块热度统计（可为空数组 → 热度因子取 1.0） */
  moduleHotness: ModuleHotnessInput[];
  /** 对外接口文件清单（API 路由/入口文件，用于安全敞口加权；可为空） */
  exposedFiles?: string[];
}
