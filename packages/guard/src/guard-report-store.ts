/**
 * 门禁报告本地落库（guard-report-store.ts）
 *
 * 以项目本地 JSONL（<project>/.zhshield/guard-reports.jsonl）留存门禁检查记录，
 * 供 CLI hook 路径、桌面 IPC 路径、Server HTTP 路径三端共享读写。
 * 选 JSONL 而非桌面私有 SQLite：hook 在终端独立运行，够不到 Electron userData 数据库；
 * 项目内落盘与 .zhshield/diagnostics 约定一致，且天然跨端可读。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, GuardReport, RiskLevel } from './types';

/** 落库条目：GuardReport 精简可序列化形态 */
export interface GuardReportRecord {
  timestamp: string;
  triggerSource: string;
  ok: boolean | null;
  riskLevel: RiskLevel;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    blocking: number;
    errors: number;
  };
  checks: Array<{
    checkId: string;
    adapter: string;
    status: CheckResult['status'];
    severity: CheckResult['severity'];
    blocking: boolean;
    message: string;
  }>;
}

const REPORT_FILE = 'guard-reports.jsonl';
const MAX_RECORDS = 100;

export function guardReportsPath(projectPath: string): string {
  return join(projectPath, '.zhshield', REPORT_FILE);
}

/** 由报告统计推导风险等级：有拦截→high，有失败/错误→medium，否则 low */
export function deriveRiskLevel(summary: GuardReportRecord['summary']): RiskLevel {
  if (summary.blocking > 0 || summary.failed > 0) return 'high';
  if (summary.warnings > 0 || summary.errors > 0) return 'medium';
  return 'low';
}

/** GuardReport → 落库记录（含风险等级推导） */
export function toGuardReportRecord(report: GuardReport, triggerSource: string): GuardReportRecord {
  const summary: GuardReportRecord['summary'] = {
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    warnings: report.summary.warnings,
    blocking: report.summary.blocking,
    errors: report.summary.errors,
  };
  return {
    timestamp: report.generatedAt || new Date().toISOString(),
    triggerSource,
    ok: report.ok,
    riskLevel: deriveRiskLevel(summary),
    summary,
    checks: report.results.map((r) => ({
      checkId: r.checkId,
      adapter: r.adapter,
      status: r.status,
      severity: r.severity,
      blocking: r.blocking,
      message: r.message,
    })),
  };
}

/** 追加一条记录，返回落盘绝对路径；写入失败时静默（不阻断门禁主流程） */
export function appendGuardReport(projectPath: string, record: GuardReportRecord): string {
  const absPath = guardReportsPath(projectPath);
  mkdirSync(join(projectPath, '.zhshield'), { recursive: true });
  appendFileSync(absPath, `${JSON.stringify(record)}\n`, 'utf-8');
  trimToLimit(absPath);
  return absPath;
}

/** 读取最近记录（新→旧），损坏行跳过；文件不存在返回空数组 */
export function listGuardReports(projectPath: string, limit = 20): GuardReportRecord[] {
  const absPath = guardReportsPath(projectPath);
  if (!existsSync(absPath)) return [];
  const lines = readFileSync(absPath, 'utf-8').split('\n').filter(Boolean);
  const records: GuardReportRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as GuardReportRecord;
      if (parsed && parsed.timestamp) records.push(parsed);
    } catch {
      // 跳过损坏行，不因单条坏数据阻塞历史读取
    }
  }
  return records;
}

/** 文件超过上限时截断，只保留最近 MAX_RECORDS 条 */
function trimToLimit(absPath: string): void {
  try {
    const lines = readFileSync(absPath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= MAX_RECORDS) return;
    writeFileSync(absPath, `${lines.slice(-MAX_RECORDS).join('\n')}\n`, 'utf-8');
  } catch {
    // 截断失败不影响门禁主流程
  }
}
