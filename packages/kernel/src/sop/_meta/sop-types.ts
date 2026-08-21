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

// ─── 规则库能力声明 ──────────────────────────────────────────
/**
 * 规则库能力声明（文档 §5.2）— 驱动画像按需追问：
 * 画像问卷只问规则库能服务的维度，无对应规则集就不问用户。
 * 全部字段可选，未声明 = 不参与该维度的画像问卷。
 */
export interface RuleServes {
  /** 能服务的语言（'typescript' | 'python' | 'go' ... 开放类型） */
  languages?: string[];
  /** 能服务的交付物形态（'website' | 'admin' | 'mobile' | 'miniprogram' ...） */
  productForms?: string[];
  /** 能服务的架构形态（'monolith' | 'modular-monolith' | 'microservices' ...） */
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
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';

  /** 引擎可见范围（哪些引擎执行此规则） */
  applicableEngines: string[];

  /** 规则内容（适配器特定配置） */
  content: Record<string, unknown>;

  /** 标签 */
  tags: string[];

  /** 规则库能力声明（可选；未声明 = 该规则不参与画像问卷维度） */
  serves?: RuleServes;

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

/** 签名算法：HMAC-SHA256（旧，对称密钥）或 Ed25519（现行，非对称） */
export type SopSignatureAlgorithm = 'hmac-sha256' | 'ed25519';

export interface SignedSopPackage {
  version: string;
  rules: SopRule[];
  signature: string;    // HMAC-SHA256 或 Ed25519 签名（hex）
  hash: string;         // 规则内容的 SHA-256 哈希
  timestamp: Date;      // 签名时间
  /** 签名算法，缺省视为 hmac-sha256（旧格式） */
  algorithm?: SopSignatureAlgorithm;
  /** Ed25519 公钥（PEM），algorithm='ed25519' 时由签名方携带 */
  publicKey?: string;
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

// ─── 规则统计 ────────────────────────────────────────────────
export interface SopRuleStats {
  totalRules: number;
  byDomain: Record<GovernanceDomain, number>;
  byAction: Record<ActionType, number>;
  byStatus: Record<RuleLifecycleStatus, number>;
  bySeverity: Record<string, number>;
}
