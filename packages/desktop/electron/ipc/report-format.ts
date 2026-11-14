/**
 * 报告类型转换（report-format.ts）
 *
 * 引擎原生类型 → 页面期望的序列化类型。纯函数，无 Electron 依赖。
 *
 * 白名单豁免的「剔除 + 挂载」也放这里：主进程（ipc/engines-scanners）与 worker
 * 进程（pipeline-jobs）两条链路都要用同一份实现，各写一份必然漂移 —— 一条过滤、
 * 另一条不过滤，用户就会看到「安全页没有、项目体检有」的同一处问题。
 */

import type { GuardReport } from '@zh/guard';
import {
  toSuppressedDisplay,
  type SuppressedDiagnostic,
  type SuppressedDisplay,
} from '../whitelist-suppression';
import type { AdapterResult, InspectionReport } from '@zh/inspect';
import type { SecurityScanReport } from '@zh/security';
import type { HealthScore } from '@zh/scoring';
import type { PerformanceReportIssue } from '../pipeline-report';

/** 门禁报告的页面序列化类型：门禁检查项列表 + 汇总计数 + 耗时/时间戳元信息 */
export interface GuardReportData {
  summary: { totalChecks: number; passed: number; blocked: number; warnings: number; skipped?: number };
  checks: Array<{
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail' | 'skip';
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
  /**
   * 被白名单豁免的条目（已从 findings 剔除、且**不计入评分**）。
   *
   * 为什么要单独透传而不是只给个计数：豁免的价值在于「知道它被谁、为什么、
   * 到什么时候为止放过」，只给数字就分不清「豁免了 1 条」和「漏了 1 条」。
   * 缺省 = 没有豁免（向后兼容旧报告）。
   */
  suppressed?: SuppressedDisplay[];
  /** 规则通道求值账（R7）：只有计数时用户无法定位「哪条没跑、为什么」 */
  ruleChannel?: { ran: boolean; skipped: number; degraded: number };
  /** 逐条规则明细：页面据此分桶展示（degraded 黄 / skipped 中性） */
  ruleLedger?: Array<{
    ruleId: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
    degraded?: boolean;
    applicability?: string;
    reason?: string;
    durationMs?: number;
  }>;
  metadata: { duration: number; timestamp: string };
}

/** 性能报告的页面序列化类型：问题明细（含行号与自动修复可行性）+ 总数/可自动修复计数 */
export interface PerformanceReportData {
  summary: { total: number; autoFixable: number };
  issues: Array<PerformanceReportIssue>;
  metadata: { duration: number; timestamp: string };
}

export function toGuardReportData(r: GuardReport): GuardReportData {
  return {
    summary: {
      totalChecks: r.summary.total,
      passed: r.summary.passed,
      blocked: r.summary.failed,
      warnings: r.summary.warnings,
      skipped: r.summary.skipped ?? 0,
    },
    checks: r.results.map((cr) => ({
      id: cr.checkId,
      name: cr.checkId,
      status: toGuardCheckStatus(cr),
      message: cr.message,
      // 跳过（让位）不评级：行上写「跳过」却挂「中危」徽章是自相矛盾的信号
      ...(cr.status === 'skipped'
        ? {}
        : { severity: cr.severity === 'warning' ? 'medium' : cr.severity === 'error' ? 'high' : 'low' }),
    })),
    metadata: {
      duration: r.results.reduce((sum, cr) => sum + (cr.duration ?? 0), 0),
      timestamp: r.generatedAt,
    },
  };
}

/**
 * CheckResult 状态 → 页面状态。
 *
 * `skipped` 单独落 `skip`（让位：规则自述由其它阶段判定，如后置门禁），不再混进
 * `warn`：混进去就会以「中危 / N 项需处理」出现，并随「复制到 AI 修复」一并交给
 * 编码工具去「修」一条本来就写着我方设计说明的规则。降级跳过在引擎侧仍是
 * `warning`，照旧落 `warn`，不会被这条豁免吞掉。
 */
function toGuardCheckStatus(cr: GuardReport['results'][number]): GuardReportData['checks'][number]['status'] {
  if (cr.status === 'passed') return 'pass';
  if (cr.status === 'skipped') return 'skip';
  if (cr.status === 'failed' || cr.status === 'error') return 'fail';
  return 'warn';
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
      detail: attentionDetail(a),
      category: undefined,
      source: a.adapterId,
    }));
}

/**
 * 未检测的真实原因（R7）：优先透传工具自述的 `skipDetail`，其次按状态给可读口径。
 *
 * 旧实现统一写「工具不可用或已跳过」，把三种完全不同的处置方式糊成一句：
 * 没装（去装）、被画像裁剪（无需处理）、工具自己拒绝执行（看原因修配置）。
 * 用户点开「未检测」明细却看不到原因，等于数字不可行动。
 */
function attentionDetail(a: AdapterResult): string {
  if (a.skipDetail) return `${a.adapterName} 未检测：${a.skipDetail}`;
  if (a.status === 'unavailable') return `${a.adapterName} 未检测：工具不可用`;
  if (a.status === 'skipped') {
    return a.skipReason === 'degraded'
      ? `${a.adapterName} 未检测：降级跳过（工具/引擎不可用）`
      : `${a.adapterName} 未检测：已跳过`;
  }
  return `${a.adapterName} 未检测（覆盖率缺口）`;
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

/**
 * 从页面报告明细里剔除被白名单豁免的条目，并重算汇总计数。
 *
 * 为什么不能只靠「落盘时过滤」：报告对象会直接回传渲染层，若不在这里剔除，
 * 就会出现「明细列着 1 条、评分按 0 条算」的自相矛盾——用户会以为豁免没生效。
 * 匹配键用 ruleId（`normalizeSecuritySource` 把它取自 finding.id / malware.id）。
 *
 * 不重算 `securityScore`：该字段不参与任何评分（十域评分走 dimensionScore），
 * 且其公式在 `@zh/security.calculateSecurityScore`、此处重写等于复制第二份真源。
 */
export function stripSuppressed(
  data: SecurityScanReportData,
  suppressed: readonly SuppressedDiagnostic[],
): SecurityScanReportData {
  if (suppressed.length === 0) return data;
  const ids = new Set(suppressed.map((s) => s.entry.ruleId));
  const findings = data.findings.filter((f) => !ids.has(f.id));
  const malware = data.malware.filter((m) => !ids.has(m.id));
  if (findings.length === data.findings.length && malware.length === data.malware.length) {
    return data;
  }
  const countBy = (severity: string): number =>
    findings.filter((f) => f.severity === severity).length;
  return {
    ...data,
    findings,
    malware,
    summary: {
      ...data.summary,
      total: findings.length,
      critical: countBy('critical'),
      high: countBy('high'),
      medium: countBy('medium'),
      low: countBy('low'),
      malwareTotal: malware.length,
    },
  };
}

/** 把豁免清单挂到报告上（页面据此显示「已豁免 N 项」并可展开看理由/责任人/到期） */
export function withSuppressed(
  data: SecurityScanReportData,
  suppressed: readonly SuppressedDiagnostic[],
): SecurityScanReportData {
  if (suppressed.length === 0) return data;
  // 投影转换只此一份（whitelist-suppression 的 toSuppressedDisplay），
  // 避免这里再抄一遍字段清单 —— 加字段时漏改一处就会静默丢数据。
  return { ...data, suppressed: suppressed.map(toSuppressedDisplay) };
}

export function toSecurityScanReportData(
  r: SecurityScanReport & {
    ruleChannel?: { ran: boolean; skipped: number; degraded: number };
    /** 逐条规则账（R7）：页面据此列出「哪条没跑、为什么」 */
    ruleLedger?: SecurityScanReportData['ruleLedger'];
  },
): SecurityScanReportData {
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
    // P1-4：降级信息透传——0 检出 + 工具不可用 = 「没检测成」，前端必须显形
    ...(r.degraded
      ? {
          degraded: {
            unavailableTools: r.degraded.unavailableTools,
            ...(r.degraded.auditError ? { auditError: r.degraded.auditError } : {}),
          },
        }
      : {}),
    // 范围外跳过：与降级分离透传，UI 单独成行（「不适用」而非「不可用」）
    ...(r.skippedTools && r.skippedTools.length > 0
      ? {
          skippedTools: r.skippedTools.map((s) => ({ tool: s.tool, reason: s.reason })),
        }
      : {}),
    // 规则通道求值账：degraded>0 表示有规则没能评估（≠ 该规则通过）
    ...(r.ruleChannel ? { ruleChannel: r.ruleChannel } : {}),
    // R7：逐条明细透传 —— 只有计数时用户/维护者只能盲修（装工具还是清规则全靠猜）
    ...(r.ruleLedger && r.ruleLedger.length > 0 ? { ruleLedger: r.ruleLedger } : {}),
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
  /** 评分算法版本（4 = 十域聚合 + 技术债参考化 + 同事实去重 + 短板等级） */
  scoreVersion?: number;
  /** 覆盖度：计分维度里检测了几个；complete=false 时 score 只是「已检测部分均分」 */
  coverage?: HealthScore['coverage'];
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
    ...(score.coverage ? { coverage: score.coverage } : {}),
    ...(score.redLine ? { redLine: score.redLine } : {}),
  };
}
