import type { RuleConflictReport } from './rule-conflict-resolver';

export type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low';
export type MalwareType = 'reverse-shell' | 'data-exfiltration' | 'privilege-escalation'
  | 'crypto-ransomware' | 'backdoor' | 'supply-chain' | 'suspicious-behavior';
export type GarbageType = 'unused-file' | 'unused-dependency' | 'dead-code' | 'duplicate-code';

export interface Vulnerability {
  id: string;
  cveId?: string;
  severity: VulnerabilitySeverity;
  title: string;
  description: string;
  package: string;
  currentVersion: string;
  vulnerableRange: string;
  fixedVersion?: string;
  dependencyPath: string[];
  isDirectDependency: boolean;
  cvssScore?: number;
  recommendation: string;
  autoFixable: boolean;
  /** 交叉验证置信度 — high_confidence（A∩B）或 pending_confirmation（仅有单一来源） */
  confidence?: 'high_confidence' | 'pending_confirmation';
  /** 发现来源工具列表 */
  sourceTools?: string[];
}

/** 根据漏洞严重级别统计计算安全评分（0-100） */
export function calculateSecurityScore(vulnerabilities: Vulnerability[]): number {
  const vulnCritical = vulnerabilities.filter((v) => v.severity === 'critical').length;
  const vulnHigh = vulnerabilities.filter((v) => v.severity === 'high').length;
  const vulnMedium = vulnerabilities.filter((v) => v.severity === 'medium').length;
  const vulnLow = vulnerabilities.filter((v) => v.severity === 'low').length;

  return vulnCritical + vulnHigh === 0
    ? Math.max(60, 100 - vulnMedium * 5 - vulnLow * 2)
    : Math.max(0, 60 - (vulnCritical + vulnHigh) * 15);
}

export interface GarbageItem {
  id: string;
  type: GarbageType;
  path: string;
  size: number;
  reason: string;
}

export interface MalwareItem {
  id: string;
  type: MalwareType;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  file: string;
  line: number;
  pattern: string;
  evidence: string;
}

export interface SecurityScanReport {
  projectId: string;
  timestamp: Date;
  vulnerabilities: Vulnerability[];
  garbage: GarbageItem[];
  malware: MalwareItem[];
  securityScore: number;
  /** F3 二次校验报告 — malware lane 的 confirmed/falsePositives/conflicts 分流明细 */
  conflictReport?: RuleConflictReport;
  summary: {
    vulnTotal: number;
    vulnCritical: number;
    vulnHigh: number;
    vulnMedium: number;
    vulnLow: number;
    garbageTotal: number;
    malwareTotal: number;
  };
}

export interface GarbageCleanResult {
  batchId: string;
  cleaned: GarbageItem[];
  freedBytes: number;
  failed: string[];
}

export interface GarbageRestoreResult {
  restored: number;
  restoredBytes: number;
  failed: string[];
}
