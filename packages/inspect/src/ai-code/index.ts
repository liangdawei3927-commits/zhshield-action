/**
 * AI 生成代码审查（ai-code）——Phase 3 预留模块（附 E）
 *
 * 三层交付（E.4）：
 * - 免费 detectOrigin：检测标记
 * - Pro deepReview + suggestFix：深度审查 + 修复闭环（07 协议）
 * - 企业 complianceReport：合规报告
 */
export { HallucinatedDependencyCheckImpl } from './hallucinated-dependency';
export { AiOriginDetectorImpl, commitEvidenceFromLog, isAiMarkedCommit, classifyStrength } from './origin-detector';
export type { AiOriginDetector, AiOriginDetectorOptions, CommitEvidence } from './origin-detector';
export { analyzeStyleSignature } from './style-signature';
export type { StyleSignal, StyleSignalKind } from './style-signature';
export { PATTERN_RULES } from './pattern-rules';
export type { PatternHit, PatternRule, PatternRuleId } from './pattern-rules';
export { AiCodeReviewImpl } from './review';
export type { AiReviewOptions } from './review';
export type {
  AiAuditEntry,
  AiCodeReview,
  AiCodeVuln,
  AiCodeVulnRuleId,
  AiComplianceReport,
  AiEvidence,
  AiEvidenceKind,
  AiOriginFinding,
  AiStrength,
  AiToolReport,
  AiUserTag,
  AiVulnSeverity,
  HallucinatedDependencyCheck,
  HallucinatedDependencyFinding,
  PolicyViolation,
  RegistryStatus,
} from './types';
