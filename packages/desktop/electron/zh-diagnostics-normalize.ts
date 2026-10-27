import { t } from '@zh/i18n';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';
import type { PipelineReport } from '@zh/pipeline';
import type { DiagnosticEntry, DiagnosticSeverity } from './zh-diagnostics-types';

// ─── 归一化：PipelineReport → DiagnosticEntry[] ────────────────────────

export function normalizePipelineReport(report: PipelineReport): readonly DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  if (report.guard) entries.push(...normalizeGuardSource(report.guard));
  if (report.inspect) entries.push(...normalizeInspectSource(report.inspect));
  if (report.refactor) entries.push(...normalizeRefactorSource(report.refactor));
  return entries;
}

/** GuardReport 分支：check.details 里可能携带的定位明细（P1-5 透传用） */
interface GuardCheckDetailHints {
  violations?: Array<{ file?: string; line?: number; message?: string }>;
  findings?: Array<{ file?: string; line?: number; message?: string }>;
}

/** message 最多附带的定位明细条数（防止巨型报告把 message 撑爆） */
const MAX_LOCATION_LINES = 20;

/**
 * 从 check 结果中提取定位明细（P1-5 门禁结果无文件定位）。
 *
 * SOP 路径（guard engine evalToCheckResult）把 violations 塞进 details；
 * 传统 adapter 路径（security/sensitive-info scan）把 findings 塞进 details。
 * 此前 GuardReport 分支只透传聚合 message（"扫描器发现 1 个问题"），
 * file 恒为空串——定位信息躺在 details 里没人读，用户只知道"有问题"不知道改哪。
 */
function extractGuardLocations(details: unknown): GuardCheckDetailHints | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as GuardCheckDetailHints;
  const items = d.violations ?? d.findings;
  if (!Array.isArray(items) || items.length === 0) return null;
  return {
    ...(Array.isArray(d.violations) ? { violations: d.violations } : {}),
    ...(Array.isArray(d.findings) ? { findings: d.findings } : {}),
  };
}

/** 把定位明细拼进 message（每条 file:line message，超出上限截断计数） */
function appendLocationsToMessage(
  message: string,
  items: Array<{ file?: string; line?: number; message?: string }>,
): string {
  const shown = items.slice(0, MAX_LOCATION_LINES);
  const lines = shown.map((v) => {
    const loc = [v.file, v.line !== undefined ? String(v.line) : '']
      .filter(Boolean)
      .join(':');
    return `- ${loc || '(无定位)'} ${v.message ?? ''}`.trimEnd();
  });
  const rest = items.length - shown.length;
  const body = lines.join('\n');
  return rest > 0 ? `${message}\n${body}\n…等共 ${items.length} 条` : `${message}\n${body}`;
}

/** guard 输出可能是 GuardReport（adapter 模式）或 RuleEngineReport（SOP 模式） */
export function normalizeGuardSource(
  guard: GuardReport | RuleEngineReport,
): readonly DiagnosticEntry[] {
  if ('evaluations' in guard) {
    return normalizeRuleEngine(guard, 'guard');
  }
  // 旧版 pipeline-worker（JSON 剥键序列化）可能产出无 results 的 guard 段：
  // 直接 .filter 会 TypeError，persistDiagnostics 抛错 → 诊断文件永不刷新。
  const guardResults = guard.results;
  if (!Array.isArray(guardResults)) return [];
  return guardResults
    .filter((result) => result.status !== 'passed')
    .map((result) => {
      const hints = extractGuardLocations(result.details);
      const items = hints?.violations ?? hints?.findings;
      const first = items?.[0];
      return {
        ruleId: result.checkId,
        severity: result.severity,
        category: 'quality',
        message:
          items && items.length > 0
            ? appendLocationsToMessage(result.message, items)
            : result.message,
        file: first?.file ?? '',
        ...(first?.line !== undefined ? { line: first.line } : {}),
        autoFixable: false,
        source: 'guard' as const,
        fingerprint: `${result.checkId}:${result.adapter}:0`,
      };
    });
}

/** inspect 输出可能是 InspectionReport 或 RuleEngineReport（SOP 模式） */
export function normalizeInspectSource(
  inspect: InspectionReport | RuleEngineReport,
): readonly DiagnosticEntry[] {
  if ('evaluations' in inspect) {
    return normalizeRuleEngine(inspect, 'inspect');
  }
  // 同 guard：旧版 worker 剥键后可能无 issues（今天 fixed 的 inspect.json 曾 esloc
  // undefined + issues 缺失 → UI 读快照得 0 分）。防御后空数组照常落盘 0 检出。
  const inspectIssues = inspect.issues;
  if (!Array.isArray(inspectIssues)) return [];
  return inspectIssues.map((issue) => ({
    ruleId: issue.ruleId,
    severity: issue.severity,
    category: issue.category,
    message: issue.message,
    file: issue.file,
    line: issue.line,
    column: issue.column,
    suggestion: issue.suggestion,
    autoFixable: issue.autoFixable,
    source: 'inspect' as const,
    fingerprint: issue.fingerprint,
  }));
}

function normalizeRuleEngine(
  report: RuleEngineReport,
  source: 'guard' | 'inspect',
): readonly DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  for (const evaluation of report.evaluations) {
    if (evaluation.violations && evaluation.violations.length > 0) {
      for (const violation of evaluation.violations) {
        entries.push({
          ruleId: violation.ruleId,
          severity: mapViolationSeverity(violation.severity),
          category: 'quality',
          message: violation.message,
          file: violation.file,
          line: violation.line,
          column: violation.column,
          suggestion: violation.suggestion,
          autoFixable: false,
          source,
          fingerprint: `${violation.ruleId}:${violation.file}:${violation.line ?? 0}`,
        });
      }
      continue;
    }
    // 整规则失败且无 violation 明细（如依赖审计、工具链报错）：用 evaluation 级信息生成条目，
    // 否则 UI 显示失败而诊断文件为空，OpenCode 侧拿不到任何问题。
    // error（工具执行失败）打 toolError 标记：评分链路豁免（见 DiagnosticEntry.toolError），
    // failed（规则真检出失败）仍是业务问题照常扣分。
    if (evaluation.status === 'failed' || evaluation.status === 'error') {
      const ruleId = evaluation.rule?.id ?? 'guard/rule';
      const file = evaluation.files?.[0] ?? '';
      entries.push({
        ruleId,
        severity: evaluation.status === 'error' ? 'warning' : 'error',
        category: 'quality',
        message: evaluation.message ?? t('electron.diagnostics.ruleFailed', { ruleId }),
        file,
        autoFixable: false,
        source,
        fingerprint: `${ruleId}:${file}:0`,
        ...(evaluation.status === 'error' ? { toolError: true as const } : {}),
      });
    }
  }
  return entries;
}

export function normalizeRefactorSource(refactor: RefactorReport): readonly DiagnosticEntry[] {
  if (!Array.isArray(refactor.files)) return [];
  return refactor.files.flatMap((file) =>
    file.smells.map((smell) => ({
      ruleId: smell.ruleId,
      severity: smell.severity,
      category: smell.category,
      message: smell.message,
      file: smell.location.filePath,
      line: smell.location.line,
      column: smell.location.column,
      suggestion: smell.suggestion.description,
      autoFixable: smell.suggestion.autoFixable,
      source: 'refactor' as const,
      fingerprint: `${smell.ruleId}:${smell.location.filePath}:${smell.location.line}`,
    })),
  );
}

/** RuleEngine violation 严重度 → 三级诊断严重度 */
function mapViolationSeverity(
  severity: NonNullable<RuleEvaluation['violations']>[number]['severity'] | 'warning',
): DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high':
    case 'error':
      return 'error';
    case 'medium':
    case 'low':
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return assertNever(severity);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable severity: ${String(value)}`);
}
