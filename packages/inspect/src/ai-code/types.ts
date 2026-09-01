/**
 * AI 生成代码审查数据模型（types.ts）
 *
 * 忠实对齐《08-商业化P0实现规格》附 E.2 / E.3：
 * - 检测标记（免费层）：AiOriginFinding + AiEvidence，只输出可解释证据分级，
 *   绝不输出概率黑盒分数（边界 1）；
 * - 深度审查漏洞（Pro 层）：AiCodeVuln，ruleId 值域固定为三类；
 * - 企业合规（企业层）：AiComplianceReport（MVP 仅结构化产出，不做策略下发）。
 */
import type { ProjectProfile } from '@zh/dependency';

// ── ① 检测标记（免费层） ──

/** 证据来源类别（E.5 信号源） */
export type AiEvidenceKind = 'commit-meta' | 'style-signature' | 'user-tagged' | 'tool-report';

/** 证据分级：可解释，不做概率黑盒（边界 1） */
export type AiStrength = 'strong' | 'suggestive' | 'uncertain';

/** 单条可解释证据：kind + detail 供 UI 分层展示，confidence 为内部权重不直接展示 */
export interface AiEvidence {
  kind: AiEvidenceKind;
  detail: string;
  /** 0-1 内部权重（不直接展示，仅用于分级） */
  confidence: number;
}

/**
 * 单文件 AI 来源检测标记：
 * - strong      = 多类证据一致（commit 标记 + 风格突变 + 用户标注）
 * - suggestive  = 单类强证据或弱证据组合
 * - uncertain   = 特征存在但不充分 → 不标记为 AI 生成，仅提示（边界 2）
 */
export interface AiOriginFinding {
  findingId: string;
  file: string;
  evidence: readonly AiEvidence[];
  strength: AiStrength;
}

// ── ② 深度审查漏洞（Pro 层） ──

/** AiCodeVuln.ruleId 值域（附 E.2 固定枚举） */
export type AiCodeVulnRuleId =
  'ai-hallucinated-dependency' | 'ai-unsafe-default' | 'ai-boundary-miss';

/** 漏洞严重度 */
export type AiVulnSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 深度审查漏洞：fix 字段输出给 07 协议直接消费（码盾发现 → AI 修复闭环） */
export interface AiCodeVuln {
  vulnId: string;
  ruleId: AiCodeVulnRuleId;
  file: string;
  line: number;
  severity: AiVulnSeverity;
  description: string;
  /** 修复建议（07 协议直接消费） */
  fix: string;
}

// ── ③ 企业合规（企业层） ──

/** 审计日志条目：谁 / 何时 / 审查了哪些范围 */
export interface AiAuditEntry {
  at: string;
  action: string;
  scope: string;
  actor: string;
}

/** 策略违反（MVP 不配置策略，恒为空数组） */
export interface PolicyViolation {
  module: string;
  policyId: string;
  detectedAt: string;
}

/** 企业合规报告：aiCodeRatio 基于证据标记结果计算，不是概率黑盒 */
export interface AiComplianceReport {
  generatedAt: string;
  aiCodeRatio: number;
  trend: { period: 'week' | 'month'; delta: number };
  riskByModule: readonly { module: string; vulnCount: number }[];
  auditLog: readonly AiAuditEntry[];
  policyViolations: readonly PolicyViolation[];
}

// ── 可选输入信号 ──

/** 用户主动标注"这段是 AI 写的"（唯一确定性信号，E.5） */
export interface AiUserTag {
  file: string;
  source?: string;
}

/** IDE/AI 工具的生成物报告（E.5 信号源：tool-report） */
export interface AiToolReport {
  file: string;
  detail: string;
}

// ── 幻觉依赖（附 E.3） ──

/** registry 查证结果：离线零外联约束（边界 3） */
export type RegistryStatus = 'not-found' | 'typosquat-similar' | 'unverified-offline';

/**
 * 幻觉依赖候选：AI 引用但项目内无法解析的包名。
 * declared 记录 package.json 中的声明范围（当前 MVP 仅产出未声明候选，恒为缺省）。
 */
export interface HallucinatedDependencyFinding {
  /** AI 幻觉引用的包名 */
  packageName: string;
  referencedFrom: readonly { file: string; line: number }[];
  /** 是否已在 package.json 声明 */
  declared?: string;
  /**
   * 本地离线查证结果：
   * - not-found          本地依赖闭环（声明/锁文件/node_modules）可判定且不含该包
   * - typosquat-similar  与知名包名相似（附 B 交叉验证，抢注即 critical）
   * - unverified-offline 离线信息不足，不断言"不存在"（边界 3 降级）
   */
  registryStatus: RegistryStatus;
  evidence: readonly string[];
}

/** 幻觉依赖检测器契约（附 E.3） */
export interface HallucinatedDependencyCheck {
  check(project: ProjectProfile): Promise<readonly HallucinatedDependencyFinding[]>;
}

// ── 门面契约（附 E.3） ──

/** AI 代码审查门面：三层交付（免费 detectOrigin / Pro deepReview / 企业 complianceReport） */
export interface AiCodeReview {
  /** 免费：检测标记（多信号证据，见 E.5） */
  detectOrigin(project: ProjectProfile): Promise<readonly AiOriginFinding[]>;

  /** Pro：深度审查（幻觉依赖 + 不安全模式规则集），scope 限制扫描范围 */
  deepReview(
    project: ProjectProfile,
    opts: { readonly scope?: readonly string[] },
  ): Promise<readonly AiCodeVuln[]>;

  /** Pro：修复建议（输出给 07 协议 → AI 修复闭环） */
  suggestFix(vuln: AiCodeVuln): Promise<string>;

  /** 企业：合规报告 + 策略下发 */
  complianceReport(project: ProjectProfile): Promise<AiComplianceReport>;
}
