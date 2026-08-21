/**
 * 报告类型转换（report-format.ts）
 *
 * 引擎原生类型 → 页面期望的序列化类型。纯函数，无 Electron 依赖。
 */

import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { SecurityScanReport } from '@zh/security';
import type { HealthScore } from '@zh/scoring';

export interface GuardReportData {
  summary: { totalChecks: number; passed: number; blocked: number; warnings: number };
  checks: Array<{ id: string; name: string; status: 'pass' | 'warn' | 'fail'; message: string; severity?: string }>;
  metadata: { duration: number; timestamp: string };
}

export interface InspectionReportData {
  summary: { total: number; passed: number; warnings: number; failures: number };
  checks: Array<{ id: string; name: string; status: 'pass' | 'warn' | 'fail'; detail: string; category?: string }>;
  metadata: { duration: number; timestamp: string };
}

export interface SecurityScanReportData {
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    malwareTotal: number;
    garbageTotal: number;
    garbageSize: number;
  };
  /** 漏洞扫描（依赖 CVE） */
  findings: Array<{ id: string; title: string; severity: string; file: string; description: string; recommendation?: string }>;
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
  /** 垃圾清理（无用文件 / 未用依赖 / 死代码） */
  garbage: Array<{ id: string; type: string; path: string; size: number; reason: string }>;
  /** 安全评分 0-100 */
  securityScore: number;
  metadata: { duration: number; timestamp: string };
}

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
      status: cr.status === 'passed' ? 'pass' as const : cr.status === 'failed' || cr.status === 'error' ? 'fail' as const : 'warn' as const,
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
  return {
    summary: {
      total: r.summary.total,
      passed: r.summary.info,
      warnings: r.summary.warning,
      failures: r.summary.error,
    },
    checks: r.issues.map((issue) => ({
      id: issue.id,
      name: issue.ruleId,
      status: issue.severity === 'info' ? 'pass' as const : issue.severity === 'warning' ? 'warn' as const : 'fail' as const,
      detail: issue.message,
      category: issue.category,
      source: issue.source,
    })),
    metadata: {
      duration: r.duration,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
    },
  };
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
      garbageTotal: r.summary.garbageTotal,
      garbageSize: r.garbage.reduce((sum, g) => sum + (g.size ?? 0), 0),
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
    garbage: r.garbage.map((g) => ({
      id: g.id,
      type: g.type,
      path: g.path,
      size: g.size,
      reason: g.reason,
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
}

export function toHealthScoreData(score: HealthScore): HealthScoreData {
  return {
    score: score.overall,
    dimensions: score.dimensions,
    summary: score.grade,
    timestamp: score.timestamp instanceof Date ? score.timestamp.toISOString() : String(score.timestamp),
  };
}
