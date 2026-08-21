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

/**
 * 根据漏洞与恶意代码严重级别统计计算安全评分（0-100）。
 *
 * - 高危/严重漏洞与恶意代码（后门、反弹Shell 等）直接跌破 60 基准线，每项分别扣 15 / 25 分
 * - 仅中低危时按数量线性扣分；恶意代码扣分重于漏洞，且存在时下限降到 30
 */
export function calculateSecurityScore(
  vulnerabilities: Vulnerability[],
  malware: MalwareItem[] = [],
): number {
  const vulnCritical = vulnerabilities.filter((v) => v.severity === 'critical').length;
  const vulnHigh = vulnerabilities.filter((v) => v.severity === 'high').length;
  const vulnMedium = vulnerabilities.filter((v) => v.severity === 'medium').length;
  const vulnLow = vulnerabilities.filter((v) => v.severity === 'low').length;

  const malCritical = malware.filter((m) => m.severity === 'critical').length;
  const malHigh = malware.filter((m) => m.severity === 'high').length;
  const malMedium = malware.filter((m) => m.severity === 'medium').length;
  const malLow = malware.filter((m) => m.severity === 'low').length;

  const severePenalty =
    (vulnCritical + vulnHigh) * 15 +
    (malCritical + malHigh) * 25;
  if (severePenalty > 0) {
    return Math.max(0, 60 - severePenalty);
  }

  const lightPenalty =
    vulnMedium * 5 + vulnLow * 2 +
    malMedium * 10 + malLow * 5;
  const floor = malMedium + malLow > 0 ? 30 : 60;
  return Math.max(floor, 100 - lightPenalty);
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

/** 一键清理结果（文件已移入 .zhshield/trash 回收站，可恢复） */
export interface GarbageCleanResult {
  /** 回收站批次 ID，用于后续恢复 */
  batchId: string;
  /** 成功清理的条目 */
  cleaned: Array<{ id: string; path: string; size: number }>;
  /** 释放的字节数 */
  freedBytes: number;
  /** 清理失败的条目与原因 */
  failed: string[];
}

/** 回收站恢复结果 */
export interface GarbageRestoreResult {
  /** 成功恢复的文件数 */
  restored: number;
  /** 恢复的字节数 */
  restoredBytes: number;
  /** 恢复失败的条目与原因 */
  failed: string[];
}

export interface SecurityScanReport {
  projectId: string;
  timestamp: Date;
  vulnerabilities: Vulnerability[];
  garbage: GarbageItem[];
  malware: MalwareItem[];
  securityScore: number;
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
