import type { DependencyReportData, SecurityScanReportData } from '../types/electron';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import {
  evaluateComplianceBaseline,
  toDepsEvidence,
  toSecurityEvidence,
  type ComplianceReport,
} from './baseline';

/**
 * 合规基线求值（只读）：安全域报告 + 依赖管家落盘报告 → ASVS 条款视图。
 *
 * 不启动任何扫描；任一报告缺失时对应条款落 no-evidence（未检测 ≠ 通过）。
 * 独立成 hook：安全中心页面的状态装配已顶到 long-method 阈值，这里只负责
 * 「取证据 + 求值」，避免页面状态机再长一截。
 */
export function useComplianceReport(
  projectPath: string,
  securityReport: SecurityScanReportData | null,
): ComplianceReport {
  const depsReport = useSavedDomainReport<DependencyReportData>(projectPath, 'deps', null);
  return evaluateComplianceBaseline({
    security: toSecurityEvidence(securityReport),
    deps: toDepsEvidence(depsReport),
  });
}
