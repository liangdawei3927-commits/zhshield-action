import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { t } from '@zh/i18n';
import { WhitelistManager } from '@zh/guard';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';
import type { PipelineReport } from '@zh/pipeline';

// ─── 诊断条目（归一化，跨 guard/inspect/refactor） ─────────────────────

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticEntry {
  /** 规则 ID（guard 为 checkId，refactor 为 smell 规则） */
  ruleId: string;
  severity: DiagnosticSeverity;
  category: string;
  message: string;
  /** 相对项目根的文件路径；无位置信息的条目为空字符串 */
  file: string;
  /** 1-based 行号 */
  line?: number;
  /** 1-based 列号 */
  column?: number;
  suggestion?: string;
  autoFixable: boolean;
  /** 来源引擎：guard | inspect | refactor */
  source: 'guard' | 'inspect' | 'refactor';
  /** 去重指纹 */
  fingerprint: string;
}

// ─── LSP 风格按文件视图（模拟 publishDiagnostics） ─────────────────────

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=error, 2=warning, 3=info */
  severity: 1 | 2 | 3;
  code: string;
  source: 'zhshield';
  message: string;
  data: {
    category: string;
    autoFixable: boolean;
    suggestion?: string;
  };
}

export interface FileDiagnostics {
  uri: string;
  diagnostics: readonly LspDiagnostic[];
}

// ─── 落盘报告 ─────────────────────────────────────────────────────────

export interface DiagnosticsReport {
  version: '1.0';
  project: { path: string; name: string };
  generatedAt: string;
  summary: { total: number; error: number; warning: number; info: number };
  issues: readonly DiagnosticEntry[];
  files: readonly FileDiagnostics[];
}

// ─── 归一化：PipelineReport → DiagnosticEntry[] ────────────────────────

export function normalizePipelineReport(report: PipelineReport): readonly DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  if (report.guard) entries.push(...normalizeGuardSource(report.guard));
  if (report.inspect) entries.push(...normalizeInspectSource(report.inspect));
  if (report.refactor) entries.push(...normalizeRefactorSource(report.refactor));
  return entries;
}

/** guard 输出可能是 GuardReport（adapter 模式）或 RuleEngineReport（SOP 模式） */
export function normalizeGuardSource(guard: GuardReport | RuleEngineReport): readonly DiagnosticEntry[] {
  if ('evaluations' in guard) {
    return normalizeRuleEngine(guard, 'guard');
  }
  return guard.results
    .filter((result) => result.status !== 'passed')
    .map((result) => ({
      ruleId: result.checkId,
      severity: result.severity,
      category: 'quality',
      message: result.message,
      file: '',
      autoFixable: false,
      source: 'guard' as const,
      fingerprint: `${result.checkId}:${result.adapter}:0`,
    }));
}

/** inspect 输出可能是 InspectionReport 或 RuleEngineReport（SOP 模式） */
export function normalizeInspectSource(inspect: InspectionReport | RuleEngineReport): readonly DiagnosticEntry[] {
  if ('evaluations' in inspect) {
    return normalizeRuleEngine(inspect, 'inspect');
  }
  return inspect.issues.map((issue) => ({
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

function normalizeRuleEngine(report: RuleEngineReport, source: 'guard' | 'inspect'): readonly DiagnosticEntry[] {
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
    // 否则 UI 显示失败而诊断文件为空，OpenCode 侧拿不到任何问题
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
      });
    }
  }
  return entries;
}

export function normalizeRefactorSource(refactor: RefactorReport): readonly DiagnosticEntry[] {
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

/** RuleEngine violation 五级严重度 → 三级诊断严重度 */
function mapViolationSeverity(severity: NonNullable<RuleEvaluation['violations']>[number]['severity']): DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high':
    case 'error':
      return 'error';
    case 'medium':
    case 'low':
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

// ─── 汇总 + LSP 视图 ───────────────────────────────────────────────────

export function buildDiagnosticsReport(
  project: { path: string; name: string },
  issues: readonly DiagnosticEntry[],
  generatedAt: string,
): DiagnosticsReport {
  const byFile = new Map<string, LspDiagnostic[]>();
  for (const issue of issues) {
    if (!issue.file) continue;
    const uri = `file://${join(project.path, issue.file)}`;
    const list = byFile.get(uri) ?? [];
    list.push(toLspDiagnostic(issue));
    byFile.set(uri, list);
  }
  return {
    version: '1.0',
    project,
    generatedAt,
    summary: {
      total: issues.length,
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    issues,
    files: Array.from(byFile.entries(), ([uri, diagnostics]) => ({ uri, diagnostics })),
  };
}

function toLspDiagnostic(issue: DiagnosticEntry): LspDiagnostic {
  // 协议：0-based 行列号，单字符 span（start = 起点，end = 起点 + 1）
  const line = (issue.line ?? 1) - 1;
  const character = (issue.column ?? 1) - 1;
  const data: LspDiagnostic['data'] = {
    category: issue.category,
    autoFixable: issue.autoFixable,
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
  };
  return {
    range: { start: { line, character }, end: { line, character: character + 1 } },
    severity: mapLspSeverity(issue.severity),
    code: issue.ruleId,
    source: 'zhshield',
    message: issue.message,
    data,
  };
}

function mapLspSeverity(severity: DiagnosticSeverity): LspDiagnostic['severity'] {
  switch (severity) {
    case 'error':
      return 1;
    case 'warning':
      return 2;
    case 'info':
      return 3;
    default:
      return assertNever(severity);
  }
}

// ─── 落盘 ──────────────────────────────────────────────────────────────

/** 写入 <project>/.zhshield/diagnostics/latest.json，返回绝对路径 */
export function writeDiagnosticsFile(report: DiagnosticsReport): string {
  const dir = join(report.project.path, '.zhshield', 'diagnostics');
  mkdirSync(dir, { recursive: true });
  const absPath = join(dir, 'latest.json');
  writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return absPath;
}

/** 依据 <project>/.zhshield/whitelist.yml 过滤被白名单压制的误报条目（rule+file 精确匹配） */
function filterWhitelisted(
  whitelist: WhitelistManager,
  entries: readonly DiagnosticEntry[],
): readonly DiagnosticEntry[] {
  return entries.filter(
    (entry) => !(entry.file && whitelist.isWhitelisted(entry.ruleId, entry.file).whitelisted),
  );
}

/** pipeline 报告一键归一化并落盘（dryRun 由调用方决定是否跳过） */
export async function persistDiagnostics(projectPath: string, report: PipelineReport): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const issues = filterWhitelisted(whitelist, normalizePipelineReport(report));
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    issues,
    new Date().toISOString(),
  );
  return writeDiagnosticsFile(diagnostics);
}

/**
 * 用已归一化的 entries 直接落盘。
 * 供 runInspect/runGuard/runRefactor/runPerformance 单独扫描时复用，
 * 避免每次单独扫描都走 PipelineReport 形状。
 */
export async function persistDiagnosticsFromEntries(
  projectPath: string,
  entries: readonly DiagnosticEntry[],
): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    filterWhitelisted(whitelist, entries),
    new Date().toISOString(),
  );
  return writeDiagnosticsFile(diagnostics);
}

/** PerformanceReportData 形状（结构化类型，避免与 report-format.ts 形成循环依赖） */
interface PerformanceDataLike {
  issues: ReadonlyArray<{
    id: string;
    ruleId: string;
    severity: string;
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
    autoFixable: boolean;
  }>;
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
 * performance 属于 inspect 维度，source 标 'inspect'，category 标 'performance'，
 * 便于 Trae/MCP 端按维度过滤。
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
    source: 'inspect' as const,
    fingerprint: `${issue.ruleId}:${issue.file}:${issue.line ?? 0}`,
  }));
}
