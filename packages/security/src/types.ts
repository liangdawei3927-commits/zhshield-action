import type { RuleConflictReport } from './rule-conflict-resolver';

/** 漏洞严重级别（四档）；无 critical/high 时按 medium/low 的低权重扣分，见 calculateSecurityScore */
export type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low';
/** 恶意代码/威胁类型分类：注入检测与启发式扫描共用同一枚举 */
export type MalwareType =
  | 'reverse-shell'
  | 'data-exfiltration'
  | 'privilege-escalation'
  | 'crypto-ransomware'
  | 'backdoor'
  | 'supply-chain'
  | 'suspicious-behavior';
/** 垃圾条目类型：未使用文件 / 未使用依赖 / 死代码 / 重复代码 / 构建产物 */
export type GarbageType =
  'unused-file' | 'unused-dependency' | 'dead-code' | 'duplicate-code' | 'build-artifact';

/** 漏洞条目：包坐标、受影响版本区间、修复建议与自动修复可行性，附交叉验证置信度与来源工具 */
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

/** 垃圾条目：可清理对象的类型、路径、占用体积与判定理由 */
export interface GarbageItem {
  id: string;
  type: GarbageType;
  path: string;
  size: number;
  reason: string;
}

/** 恶意代码条目：类型、严重级别、命中文件与行号、匹配模式名与原始证据片段 */
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

/** 安全扫描报告：漏洞/垃圾/恶意三类结果 + 安全评分 + 计数汇总，附 F3 二次校验的 malware 冲突报告 */
export interface SecurityScanReport {
  projectId: string;
  timestamp: Date;
  vulnerabilities: Vulnerability[];
  garbage: GarbageItem[];
  malware: MalwareItem[];
  securityScore: number;
  /** F3 二次校验报告 — malware lane 的 confirmed/falsePositives/conflicts 分流明细 */
  conflictReport?: RuleConflictReport;
  /**
   * P1-4：扫描降级信息。外部工具不可用（trivy/grype/depcheck/semgrep/ort 未安装
   * 或执行失败）或依赖审计（pnpm/npm audit 需联网）失败时，vulnTotal=0 的含义是
   * 「没检测成」而不是「没有漏洞」——必须随报告显形，调用方/前端据此标注降级，
   * 绝不允许静默把 0 检出呈现成安全。全部工具可用且审计成功时无此字段。
   */
  degraded?: {
    unavailableTools: string[];
    auditError?: string;
  };
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
