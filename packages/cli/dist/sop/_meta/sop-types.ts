// ─── 三维分类体系：治理域 ──────────────────────────────────
export type GovernanceDomain =
  | 'guard'     // 拦截域 — 门禁拦截（L1/L2/L3）
  | 'inspect'   // 巡检域 — 巡检扫描（20+ 适配器）
  | 'security'  // 安全域 — 漏洞扫描 + 垃圾清理 + 病毒查杀
  | 'sentinel'  // 监控域 — 运行时监控、告警、事件管理
  | 'evolve'    // 演进域 — 评分量化 + AI 规则自优化
  | 'refactor'; // 重构域 — 代码异味检测 + 自动重构 + AST 分析

// ─── 三维分类体系：动作类型 ──────────────────────────────────
export type ActionType =
  | 'scan'       // 扫描检测 — 主动发现代码/依赖/运行时中的问题
  | 'block'      // 拦截阻断 — 在关键节点阻止不合格行为
  | 'score'      // 评分量化 — 将检测结果转化为量化评分
  | 'alert'      // 告警响应 — 发现异常后通知和分级响应
  | 'suggest'    // 修复建议 — 基于经验库生成可执行的修复方案
  | 'calibrate'; // 进化校准 — 根据反馈调整规则本身

// ─── 三维分类体系：数据来源 ──────────────────────────────────
export type DataSource =
  | 'external'   // 外部标准 — GitHub Advisory、CVE、npm audit、开源规范库
  | 'internal'   // 内部模式 — 项目实际问题模式、代码异味、架构违规
  | 'community'  // 社区贡献 — 开发者提交的新规则、最佳实践
  | 'official';  // 官方维护 — 智汇码盾官方定义的检查标准

// ─── 规则生命周期 ────────────────────────────────────────────
export type RuleLifecycleStatus = 'draft' | 'trial' | 'active' | 'deprecated';

// ─── 执行模式 ────────────────────────────────────────────────
export type ExecutionMode = 'sync' | 'async' | 'periodic' | 'event';

// ─── 严重级别 ────────────────────────────────────────────────
/** 规则严重级别（F1 起含 'error'：对齐 ESLint/semgrep 的 ERROR 档，使存量 YAML 首次成为一等合法值） */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'error';

// ─── 能力声明 ────────────────────────────────────────────────
export interface SopServes {
  /** 支持的语言 */
  languages?: string[];

  /** 支持的产品形态 */
  productForms?: string[];

  /** 支持的架构 */
  architectures?: string[];
}

// ─── SOP 规则 ────────────────────────────────────────────────
export interface SopRule {
  /** 规则 ID 格式：{治理域}.{动作类型}.{数据来源}.{规则名} */
  id: string;

  /** 规则名称（人类可读） */
  name: string;

  /** 治理域 */
  domain: GovernanceDomain;

  /** 动作类型 */
  action: ActionType;

  /** 数据来源 */
  source: DataSource;

  /** 规则描述 */
  description: string;

  /** 生命周期状态 */
  status: RuleLifecycleStatus;

  /** 执行模式 */
  executionMode: ExecutionMode;

  /** 严重级别 */
  severity: Severity;

  /** 动态升级策略（F1）：同类 warning 连续命中 threshold 次后，severity 升级为 escalateTo */
  accumulationPolicy?: {
    /** 触发升级所需的连续同类命中次数（缺省 3） */
    threshold?: number;
    /** 升级目标严重级（必须高于规则静态 severity） */
    escalateTo: Severity;
    /** 统计窗口（按 ruleId+contentKey 计数；预留字段，本期仅计数） */
    window?: number;
  };

  /** 阻断阈值（F1-4 消费）：评估失败且 effective severity >= 此值时 evaluation.blocking=true；缺省不改变现状（undefined = 不阻断） */
  blockingThreshold?: Severity;

  /** 引擎可见范围（哪些引擎执行此规则） */
  applicableEngines: string[];

  /** 规则内容（适配器特定配置） */
  content: Record<string, unknown>;

  /** 能力声明（语言/产品形态/架构） */
  serves?: SopServes;

  /** 标签 */
  tags: string[];

  /** 误报计数 */
  falsePositiveCount: number;

  /** 确认真阳性计数 */
  truePositiveCount: number;

  /** 最后使用时间 */
  lastUsedAt?: Date;

  /** 创建时间 */
  createdAt: Date;

  /** 更新时间 */
  updatedAt: Date;
}

// ─── 规则版本 ────────────────────────────────────────────────
export interface SopVersion {
  /** 语义化版本：主版本.年月日.修订号 例：1.2026.07.28.003 */
  version: string;

  /** 知识库版本（检查规则） */
  knowledge: string;

  /** 经验库版本（误报校准） */
  experience: string;

  /** 病毒库版本（恶意特征） */
  malware: string;

  /** 发布时间 */
  publishedAt: Date;

  /** 完整性校验 SHA-256 */
  hash: string;

  /** 增量包大小（字节） */
  size: number;
}

// ─── 增量 Diff ──────────────────────────────────────────────
export interface SopDiff {
  /** 目标版本号 */
  version: string;

  /** 源版本号 */
  fromVersion: string;

  /** 最小兼容客户端版本 (semver) */
  compatibility: string;

  /** 新增的规则 */
  added: SopRule[];

  /** 被删除的规则 ID */
  removed: string[];

  /** 被修改的规则（完整内容） */
  modified: SopRule[];

  /** 未变化的规则 ID（不传输内容） */
  unchanged: string[];

  /** 元数据 */
  metadata: SopDiffMetadata;
}

export interface SopDiffMetadata {
  /** 目标版本总规则数 */
  totalRules: number;

  /** 增量包大小（字节） */
  diffSize: number;

  /** 增量包完整性哈希 */
  hash: string;
}

// ─── 签名的 SOP 包 ──────────────────────────────────────────
export interface SignedSopPackage {
  version: string;
  rules: SopRule[];
  signature: string;    // HMAC-SHA256 签名
  hash: string;         // 规则内容的 SHA-256 哈希
  timestamp: Date;      // 签名时间
}

// ─── 同步结果 ────────────────────────────────────────────────
export interface SyncResult {
  updated: boolean;
  reason?: 'already_latest' | 'compatibility_error' | 'hash_mismatch' | 'network_error';
  fromVersion?: string;
  toVersion?: string;
  ruleCount?: number;
}

// ─── 规则查询过滤器 ──────────────────────────────────────────
export interface SopRuleFilter {
  domain?: GovernanceDomain;
  action?: ActionType;
  source?: DataSource;
  status?: RuleLifecycleStatus;
  severity?: string;
  tags?: string[];
  search?: string;
}

// ─── 模块特征映射 ────────────────────────────────────────────
export interface ProjectFeature {
  framework?: string;
  language?: string;
  features: string[];
}

// ─── 结构化项目画像（与 @zh/fingerprint 的 ProjectProfile 结构兼容，
//     kernel 不反向依赖 fingerprint，仅声明投影所需字段） ──────────
export interface ProjectProfile {
  schemaVersion?: number;
  architecture?: { value?: string; confidence?: number; signals?: unknown[] };
  targets?: Array<{
    id?: string;
    path?: string;
    language?: { value?: string; confidence?: number; signals?: unknown[] };
    frameworks?: Array<{ value?: string; confidence?: number; signals?: unknown[] }>;
    productForm?: { value?: string; confidence?: number; signals?: unknown[] };
    routeKey?: string;
  }>;
  environments?: Array<{ value?: string; confidence?: number; signals?: unknown[] }>;
}

// ─── 规则统计 ────────────────────────────────────────────────
export interface SopRuleStats {
  totalRules: number;
  byDomain: Record<GovernanceDomain, number>;
  byAction: Record<ActionType, number>;
  byStatus: Record<RuleLifecycleStatus, number>;
  bySeverity: Record<string, number>;
}
