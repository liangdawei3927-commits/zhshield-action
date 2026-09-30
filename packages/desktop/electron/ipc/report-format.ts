/**
 * 报告类型转换（report-format.ts）
 *
 * 引擎原生类型 → 页面期望的序列化类型。纯函数，无 Electron 依赖。
 */

import type { GuardReport } from '@zh/guard';
import type { AdapterResult, InspectionReport } from '@zh/inspect';
import type { SecurityScanReport } from '@zh/security';
import type { HealthScore } from '@zh/scoring';

/** 门禁报告的页面序列化类型：门禁检查项列表 + 汇总计数 + 耗时/时间戳元信息 */
export interface GuardReportData {
  summary: { totalChecks: number; passed: number; blocked: number; warnings: number };
  checks: Array<{
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    severity?: string;
  }>;
  metadata: { duration: number; timestamp: string };
}

/** 巡检报告的页面序列化类型：issue/适配器失败/覆盖率缺口统一为 check 列表 */
export interface InspectionReportData {
  summary: { total: number; passed: number; warnings: number; failures: number };
  checks: Array<{
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail' | 'attention';
    detail: string;
    category?: string;
  }>;
  metadata: { duration: number; timestamp: string };
}

/** 安全扫描报告的页面序列化类型：分级漏洞计数、漏洞/恶意代码明细与安全评分 */
export interface SecurityScanReportData {
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    malwareTotal: number;
  };
  /** 漏洞扫描（依赖 CVE） */
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    file: string;
    description: string;
    recommendation?: string;
  }>;
  /** 病毒查杀（恶意代码特征） */
  malware: Array<{
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    description: string;
    file: string;
    line: number;
    pattern: string;
    evidence: string;
  }>;
  /** 安全评分 0-100 */
  securityScore: number;
  metadata: { duration: number; timestamp: string };
}

/** 性能报告的页面序列化类型：问题明细（含行号与自动修复可行性）+ 总数/可自动修复计数 */
export interface PerformanceReportData {
  summary: { total: number; autoFixable: number };
  issues: Array<{
    id: string;
    ruleId: string;
    severity: string;
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
    autoFixable: boolean;
  }>;
  metadata: { duration: number; timestamp: string };
}

export function toGuardReportData(r: GuardReport): GuardReportData {
  return {
    summary: {
      totalChecks: r.summary.total,
      passed: r.summary.passed,
      blocked: r.summary.failed,
      warnings: r.summary.warnings,
    },
    checks: r.results.map((cr) => ({
      id: cr.checkId,
      name: cr.checkId,
      status:
        cr.status === 'passed'
          ? ('pass' as const)
          : cr.status === 'failed' || cr.status === 'error'
            ? ('fail' as const)
            : ('warn' as const),
      message: cr.message,
      severity: cr.severity === 'warning' ? 'medium' : cr.severity === 'error' ? 'high' : 'low',
    })),
    metadata: {
      duration: r.results.reduce((sum, cr) => sum + (cr.duration ?? 0), 0),
      timestamp: r.generatedAt,
    },
  };
}

export function toInspectionReportData(r: InspectionReport): InspectionReportData {
  const issueChecks = buildIssueChecks(r);
  const attentionChecks = buildAttentionChecks(r);
  const failedChecks = buildFailedAdapterChecks(r);
  return {
    summary: {
      total: r.summary.total,
      passed: r.summary.info,
      warnings: r.summary.warning,
      failures: r.summary.error + failedChecks.length,
    },
    checks: [...issueChecks, ...failedChecks, ...attentionChecks],
    metadata: {
      duration: r.duration,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
    },
  };
}

function buildIssueChecks(r: InspectionReport): InspectionReportData['checks'] {
  return r.issues.map((issue) => ({
    id: issue.id,
    name: issue.ruleId,
    status:
      issue.severity === 'info'
        ? ('pass' as const)
        : issue.severity === 'warning'
          ? ('warn' as const)
          : ('fail' as const),
    detail: issue.message,
    category: issue.category,
    source: issue.source,
  }));
}

function buildAttentionChecks(r: InspectionReport): InspectionReportData['checks'] {
  const knownNames = new Set(r.issues.map((i) => i.source));
  return r.adapterResults
    .filter((a) => getCoverageGap(a) && !knownNames.has(a.adapterId))
    .map((a) => ({
      id: `adapter:${a.adapterId}`,
      name: a.adapterName,
      status: 'attention' as const,
      detail: `${a.adapterName} 未检测（工具不可用或已跳过，覆盖率缺口）`,
      category: undefined,
      source: a.adapterId,
    }));
}

/**
 * P1（复查5）：status==='error' 且没有产出任何 issue 的适配器，此前在桌面端
 * 完全不可见（既不是覆盖率缺口，issueChecks 里也没有它）→ 用户看到"巡检完成、
 * 分数 100"，却不知道有几个工具其实跑挂了。补成 fail 检查项并带上真实原因。
 */
function buildFailedAdapterChecks(r: InspectionReport): InspectionReportData['checks'] {
  return r.adapterResults
    .filter((a) => a.status === 'error' && a.issueCount === 0 && (a.issues?.length ?? 0) === 0)
    .map((a) => ({
      id: `adapter-error:${a.adapterId}`,
      name: a.adapterName,
      status: 'fail' as const,
      detail: `${a.adapterName} 执行失败，未产出检测结果：${a.errorDetail ?? '未提供失败原因'}`,
      category: undefined,
      source: a.adapterId,
    }));
}

// 覆盖率缺口判定：unavailable/skipped/degraded 计缺口，但 out-of-scope（画像裁剪的既定跳过）不算——
// 裁剪是显式决策，非工具故障或未安装，不应稀释通过率/覆盖率。
function getCoverageGap(
  a: Pick<AdapterResult, 'adapterId' | 'status' | 'degraded' | 'skipReason'>,
): boolean {
  if (a.skipReason === 'out-of-scope') return false;
  return a.status === 'unavailable' || a.status === 'skipped' || a.degraded === true;
}

export function toSecurityScanReportData(r: SecurityScanReport): SecurityScanReportData {
  return {
    summary: {
      total: r.summary.vulnTotal,
      critical: r.summary.vulnCritical,
      high: r.summary.vulnHigh,
      medium: r.summary.vulnMedium,
      low: r.summary.vulnLow,
      malwareTotal: r.summary.malwareTotal,
    },
    findings: r.vulnerabilities.map((v) => ({
      id: v.id,
      title: v.title,
      severity: v.severity,
      file: v.package,
      description: v.description,
      recommendation: v.recommendation,
    })),
    malware: r.malware.map((m) => ({
      id: m.id,
      type: m.type,
      severity: m.severity,
      title: m.title,
      description: m.description,
      file: m.file,
      line: m.line,
      pattern: m.pattern,
      evidence: m.evidence,
    })),
    securityScore: r.securityScore,
    metadata: {
      duration: 0,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
    },
  };
}

/** 渲染进程健康评分（序列化，score 替代 overall，timestamp 为 ISO 字符串） */
export interface HealthScoreData {
  score: number;
  dimensions: HealthScore['dimensions'];
  summary: string;
  timestamp: string;
  /** 评分算法版本（2 = 十域聚合 + 红线封顶）；跨版本分数不做直接对比 */
  scoreVersion?: number;
  /** 红线封顶信息：本次汇总存在 critical 事实时有值 */
  redLine?: HealthScore['redLine'];
}

export function toHealthScoreData(score: HealthScore): HealthScoreData {
  return {
    score: score.overall,
    dimensions: score.dimensions,
    summary: score.grade,
    timestamp:
      score.timestamp instanceof Date ? score.timestamp.toISOString() : String(score.timestamp),
    ...(typeof score.scoreVersion === 'number' ? { scoreVersion: score.scoreVersion } : {}),
    ...(score.redLine ? { redLine: score.redLine } : {}),
  };
}
