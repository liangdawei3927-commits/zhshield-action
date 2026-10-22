import type { DependencyReportData, TechDebtReportData } from '../src/types/electron';
import type { PerformanceReportIssue } from './pipeline-report';
import type { DiagnosticEntry, DiagnosticSeverity } from './zh-diagnostics-types';

/** 性能报告 issue 形状：复用 pipeline-report.PerformanceReportIssue（不依赖 report-format.ts） */
interface PerformanceDataLike {
  issues: ReadonlyArray<PerformanceReportIssue>;
}

/** 性能引擎 severity（critical/high/medium/low/info）→ DiagnosticSeverity */
function mapPerformanceSeverity(severity: string): DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * 把 PerformanceReportData 归一化为 DiagnosticEntry[]。
 * category 标 'performance'（@zh/scoring 的 quality 维含该类别），source 标 'performance'
 * 使其落进 `domains/performance.json`，便于 Trae/MCP 端按维度过滤，
 * 且不覆盖 `domains/inspect.json` 里的真实巡检结果。
 * performance 条目对 quality 维的计分由 report-summary 合并该域快照后补上。
 */
export function normalizePerformanceData(data: PerformanceDataLike): readonly DiagnosticEntry[] {
  return data.issues.map((issue) => ({
    ruleId: issue.ruleId,
    severity: mapPerformanceSeverity(issue.severity),
    category: 'performance',
    message: issue.message,
    file: issue.file,
    line: issue.line,
    suggestion: issue.suggestion,
    autoFixable: issue.autoFixable,
    source: 'performance' as const,
    fingerprint: `${issue.ruleId}:${issue.file}:${issue.line ?? 0}`,
  }));
}

/** deps 引擎：投毒高危、锁文件异常、高风险许可证、环境一致性错误 → 落盘条目 */
export function normalizeDepsSource(data: DependencyReportData): readonly DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  for (const finding of data.typosquatFindings) {
    if (finding.risk === 'low') continue;
    entries.push({
      ruleId: `typosquat:${finding.nodeId}`,
      severity: finding.risk === 'high' ? 'error' : 'warning',
      category: 'dependency',
      message: finding.evidence.join('；'),
      file: '',
      autoFixable: false,
      source: 'deps',
      fingerprint: `typosquat:${finding.nodeId}:0`,
    });
  }
  if (
    data.lockfileVerification.status === 'modified' ||
    data.lockfileVerification.status === 'missing'
  ) {
    const { status, diffs, integrityFailures } = data.lockfileVerification;
    const detail = [
      ...diffs.map((d) => `${d.name} 声明 ${d.declaredVersion} ≠ 锁定 ${d.lockedVersion}`),
      ...integrityFailures,
    ];
    entries.push({
      ruleId: `lockfile:${status}`,
      severity: status === 'modified' ? 'error' : 'warning',
      category: 'dependency',
      message:
        detail.length > 0
          ? detail.join('；')
          : `锁文件${status === 'modified' ? '与声明不一致' : '缺失'}`,
      file: data.lockfileVerification.lockfilePath ?? '',
      autoFixable: false,
      source: 'deps',
      fingerprint: `lockfile:${status}:0`,
    });
  }
  for (const entry of data.licenseMatrix.entries) {
    if (entry.risk !== 'high') continue;
    entries.push({
      ruleId: `license:${entry.name}`,
      severity: 'error',
      category: 'license',
      message: `${entry.name}@${entry.version} 许可证 ${entry.license} 属高风险：${entry.reason ?? '不兼容或未认证'}`,
      file: '',
      autoFixable: false,
      source: 'deps',
      fingerprint: `license:${entry.name}:${entry.version}`,
    });
  }
  for (const env of data.envEntries) {
    if (env.severity === 'info') continue;
    entries.push({
      ruleId: `env:${env.name}`,
      severity: env.severity,
      category: 'environment',
      message: env.detail,
      file: '',
      autoFixable: false,
      source: 'deps',
      fingerprint: `env:${env.name}:0`,
    });
  }
  return entries;
}

/** severityFactor 是组内 severity 权重均值（error=3 / warning=2 / info=1），反查回原档位 */
function severityFromFactor(severityFactor: number): DiagnosticSeverity {
  if (severityFactor >= 2.5) return 'error';
  if (severityFactor >= 1.5) return 'warning';
  return 'info';
}

/** techdebt 引擎：未处理（pending/planned/in-progress）债务动作 → 落盘条目 */
export function normalizeTechDebtSource(data: TechDebtReportData): readonly DiagnosticEntry[] {
  const UNPROCESSED: ReadonlySet<string> = new Set(['pending', 'planned', 'in-progress']);
  return data.actionList
    .filter((action) => UNPROCESSED.has(action.status))
    .map((action) => ({
      ruleId: `debt:${action.actionId}`,
      severity: severityFromFactor(action.interestBreakdown.severityFactor),
      category: `techdebt:${action.category}`,
      message: `${action.module} 债务项估价 ${action.principalEstimate}，ROI ${action.roi}${action.recommended ? '（推荐优先处理）' : ''}`,
      file: action.module,
      autoFixable: false,
      source: 'techdebt' as const,
      fingerprint: `debt:${action.actionId}:0`,
    }));
}

/** security 引擎：漏洞（critical/high→error，medium/low→warning）+ 恶意代码特征 → 落盘条目 */
/** 安全扫描数据（兼容 report-format 与 electron.d.ts 两处定义：severity 取宽松 string） */
export interface SecurityScanDataLike {
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    file: string;
    line?: number;
    description: string;
    recommendation?: string;
  }>;
  malware: Array<{
    id: string;
    severity: string;
    line: number;
    title: string;
    description: string;
    file: string;
  }>;
}

export function normalizeSecuritySource(data: SecurityScanDataLike): readonly DiagnosticEntry[] {
  const mapSeverity = (s: string): DiagnosticSeverity =>
    s === 'critical' || s === 'high' ? 'error' : 'warning';
  return [
    ...data.findings.map((finding) => ({
      ruleId: finding.id,
      severity: mapSeverity(finding.severity),
      category: 'security',
      message: `${finding.title}：${finding.description}`,
      file: finding.file,
      line: finding.line,
      suggestion: finding.recommendation,
      autoFixable: false,
      source: 'security' as const,
      fingerprint: `${finding.id}:${finding.file}:${finding.line ?? 0}`,
    })),
    ...data.malware.map((item) => ({
      ruleId: item.id,
      severity: mapSeverity(item.severity),
      category: 'malware',
      message: `${item.title}：${item.description}`,
      file: item.file,
      line: item.line,
      autoFixable: false,
      source: 'security' as const,
      fingerprint: `${item.id}:${item.file}:${item.line}`,
    })),
  ];
}
