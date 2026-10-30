import {
  ACTION_TYPES,
  DATA_SOURCES,
  RULE_LIFECYCLE_STATUSES,
  EXECUTION_MODES,
  SEVERITIES,
  type SopDiff as SharedSopDiff,
  type GovernanceDomain as SharedGovernanceDomain,
} from '@zh/shared';

// ─── 三维分类体系：治理域 ──────────────────────────────────
/** 治理域：规则所属的能力分区，取值与规则 ID 的第一段一致。
 *  真源在 `@zh/shared` 的 `GOVERNANCE_DOMAINS` —— 本文件只做别名，勿再列一份字面量。 */
export type GovernanceDomain = SharedGovernanceDomain;

// ─── 三维分类体系：动作类型 ──────────────────────────────────
/** 动作类型：规则在运行时采取的行为方式，取值与规则 ID 的第二段一致 */
export type ActionType = (typeof ACTION_TYPES)[number];

// ─── 三维分类体系：数据来源 ──────────────────────────────────
/** 数据来源：规则依据的知识出处，取值与规则 ID 的第三段一致 */
export type DataSource = (typeof DATA_SOURCES)[number];

// ─── 规则生命周期 ────────────────────────────────────────────
/** 规则生命周期状态：draft 草稿 → trial 试运行 → active 生效 → deprecated 废弃 */
export type RuleLifecycleStatus = (typeof RULE_LIFECYCLE_STATUSES)[number];

// ─── 执行模式 ────────────────────────────────────────────────
/** 执行模式：规则触发时机 —— 同步校验、异步任务、周期轮询或事件驱动 */
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// ─── 严重级别 ────────────────────────────────────────────────
/** 规则严重级别（F1 起含 'error'：对齐 ESLint/semgrep 的 ERROR 档，使存量 YAML 首次成为一等合法值） */
export type Severity = (typeof SEVERITIES)[number];

// ─── 能力声明 ────────────────────────────────────────────────
/** 规则能力声明：描述规则适用的语言、产品形态与架构，供引擎筛选可执行规则 */
export interface SopServes {
  /** 支持的语言 */
  languages?: string[];

  /** 支持的产品形态 */
  productForms?: string[];

  /** 支持的架构 */
  architectures?: string[];
}

// ─── SOP 规则 ────────────────────────────────────────────────
/**
 * SOP 规则：知识库的核心单元。
 * 成员均带内联说明；id 遵循「治理域.动作类型.数据来源.规则名」四段式，
 * content 为适配器特定配置，falsePositiveCount / truePositiveCount 用于误报校准。
 */
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

// ─── 规则版本 / 增量 Diff ──────────────────────────────────
/**
 * 知识包版本与增量 diff 的字段集由 @zh/shared 单一来源持有（跨包传输契约），
 * 本包按「规则条目即 SopRule」收窄类型后转出，原有 import 路径与导出名保持不变。
 */
export type { SopVersion, SopDiffMetadata } from '@zh/shared';
/** 增量 diff：added / modified 的载荷在本包恒为完整 SopRule（同步端按规则对象消费） */
export type SopDiff = SharedSopDiff<SopRule>;

// ─── 签名的 SOP 包 ──────────────────────────────────────────

/** 规则包签名算法：缺省（无 alg 字段）视为 hmac-sha256（旧缓存包兼容） */
export type SignedSopAlg = 'hmac-sha256' | 'ed25519';

/**
 * 已签名的 SOP 规则包：rules 内容与 signature 一一对应，hash 覆盖规则正文。
 * alg 缺省视为 hmac-sha256（兼容无该字段的旧缓存包）。
 */
export interface SignedSopPackage {
  version: string;
  rules: SopRule[];
  signature: string; // 签名（HMAC-SHA256 hex 或 Ed25519 base64）
  hash: string; // 规则内容的 SHA-256 哈希
  timestamp: Date; // 签名时间
  /** 签名算法；可选，缺省 = 'hmac-sha256'（旧缓存包无此字段） */
  alg?: SignedSopAlg;
}

// ─── 同步结果 ────────────────────────────────────────────────
/**
 * 同步失败归因。
 *
 * 划分依据是「重试有没有意义」——原来只有 `network_error` 一个笼统值，
 * 令牌过期（重试一万次也没用）与服务端 500（重试可能好）在日志里完全同形。
 * · `network_error` / `timeout` / `http_error` —— 服务侧暂时不可用，重试有意义
 * · `auth_error` —— 令牌无效/缺失/无权限，重试无意义，须改配置
 * · `decode_error` —— 响应不合协议（云端返回 HTML 错误页、压缩包损坏）
 * · `signature_rejected` —— 验签未通过（安全事件，绝不重试）
 * · `apply_error` —— 数据合法但落地失败（版本不连续、写库异常）
 * · `compatibility_error` / `hash_mismatch` —— 客户端过旧 / 内容被篡改
 */
export type SyncFailureReason =
  | 'already_latest'
  | 'compatibility_error'
  | 'hash_mismatch'
  | 'network_error'
  | 'http_error'
  | 'auth_error'
  | 'timeout'
  | 'decode_error'
  | 'signature_rejected'
  | 'apply_error';

/**
 * 知识库同步结果。
 * updated=false 时 reason 必填，标明未更新的具体原因；detail 为可直接落日志的诊断细节。
 */
export interface SyncResult {
  updated: boolean;
  reason?: SyncFailureReason;
  /** 失败细节（HTTP 状态、解析异常消息等），供日志与面板诊断；成功时缺省 */
  detail?: string;
  fromVersion?: string;
  toVersion?: string;
  ruleCount?: number;
}

// ─── 规则查询过滤器 ──────────────────────────────────────────
/** 规则查询过滤器：字段全部可选，仅按已提供的条件过滤（tags / search 为包含匹配） */
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
/** 项目模块特征：识别出的框架、语言与特性列表，用于规则适用范围匹配 */
export interface ProjectFeature {
  framework?: string;
  language?: string;
  features: string[];
}

// ─── 结构化项目画像（与 @zh/fingerprint 的 ProjectProfile 结构兼容，
//     kernel 不反向依赖 fingerprint，仅声明投影所需字段） ──────────
/** 结构化项目画像：仅声明 kernel 投影所需字段，各识别项均带 value / confidence / signals */
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
/** 规则统计：总数及按治理域/动作/生命周期/严重级别的分布 */
export interface SopRuleStats {
  totalRules: number;
  byDomain: Record<GovernanceDomain, number>;
  byAction: Record<ActionType, number>;
  byStatus: Record<RuleLifecycleStatus, number>;
  bySeverity: Record<string, number>;
}

// ─── 评估状态（规则引擎评估结果；由 rule-evaluation 定义迁移至此，切断 _meta 内循环 import） ──

/** 规则评估状态：passed 通过、failed 不通过、error 执行出错、skipped 被跳过 */
export type EvaluationStatus = 'passed' | 'failed' | 'error' | 'skipped';

// ─── 加载期校验问题（由 sop-field-validation 迁移至此，切断 _meta 内循环 import） ───
// sop-content-validation 只用这两个类型，原本要反向 import sop-field-validation，
// 而后者又值导入前者 ⇒ 成环。类型不属于任何一方的实现，放在本叶子模块最合适。

/** 单条校验问题的级别 */
export type SopRuleIssueLevel = 'fatal' | 'warn';

/** 一条加载期校验问题（供诊断面板 / 日志消费） */
export interface SopRuleIssue {
  /** 规则文件路径 */
  file: string;
  /** 出问题的字段路径，如 `metadata.status` */
  field: string;
  /** 原始取值 */
  value: unknown;
  /** 人可读的判定理由 */
  reason: string;
  /** 级别：fatal 已导致该规则被拒；warn 已自动纠正 */
  level: SopRuleIssueLevel;
}
