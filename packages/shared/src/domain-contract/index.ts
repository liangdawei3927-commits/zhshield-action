/**
 * 十域职责边界契约（《07-十域职责边界与独立性契约》）的统一出口。
 */
export {
  DOMAIN_IDS,
  COVERAGE_THRESHOLD,
  createDomainReport,
  type DomainId,
  type DomainRunStatus,
  type ScoreBasis,
  type SkippedReason,
  type DomainIssue,
  type SkippedCheck,
  type DomainCoverage,
  type DomainScore,
  type DomainReport,
  type DomainReportInput,
} from './types';

export { toAbsolutePath, toRelativePath, toFileUri } from './path';

export {
  resolveSupplierDomain,
  type ConclusionIssue,
  type DomainConclusion,
  type DomainConclusionSet,
} from './conclusions';

export {
  OWNERSHIP_CLAIMS,
  resolveOwnerClaim,
  resolveOwnerId,
  validateOwnershipRegistry,
  type OwnershipMatch,
  type OwnershipClaim,
  type OwnershipConflict,
  type OwnershipConflictKind,
} from './ownership-registry';

export {
  SCAN_DOMAIN_BUDGETS,
  TOOL_CAPABILITIES,
  findToolCapability,
  validateCapabilityRegistry,
  type ToolTargetKind,
  type ToolRunRequirement,
  type RuleFamily,
  type ToolCapability,
  type CapabilityViolation,
  type CapabilityViolationKind,
} from './capability-registry';
