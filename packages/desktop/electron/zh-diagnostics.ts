import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { t } from '@zh/i18n';
import { WhitelistManager } from '@zh/guard';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';
import type { PipelineReport } from '@zh/pipeline';
import { buildHealthDimensions, SCORE_VERSION } from '@zh/scoring';
import type { DependencyReportData, TechDebtReportData } from '../src/types/electron';

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
  /** 来源引擎：guard | inspect | refactor | deps | techdebt | security */
  source: 'guard' | 'inspect' | 'refactor' | 'deps' | 'techdebt' | 'security';
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

/**
 * 按域快照附带的实时维度评分（落盘时由 @zh/scoring 统一计算，渲染层只读不算）。
 * 目前仅 inspect → quality（巡检与 quality 维的扣分口径一一对应）；
 * gate 维需 status/blocking 语义（快照条目不带），暂不实时评分。
 * version = 评分算法版本（scoreVersion 2 起）；跨版本快照的 previousScore 不参与对比。
 */
export interface DomainDimensionScore {
  /** 对应 @zh/scoring 的评分维度 */
  dimension: 'quality';
  /** 0-100（error -8 / warning -4 / info -1，下限 0） */
  score: number;
  /** 计分所依据的问题条数 */
  issues: number;
  status: 'scored' | 'not-run';
  /** 评分算法版本（v1 旧快照缺省） */
  version?: number;
}

export interface DiagnosticsReport {
  version: '1.0';
  project: { path: string; name: string };
  generatedAt: string;
  summary: { total: number; error: number; warning: number; info: number };
  issues: readonly DiagnosticEntry[];
  files: readonly FileDiagnostics[];
  /** 实时维度评分（仅 inspect 快照携带；旧快照缺省，向后兼容） */
  dimensionScore?: DomainDimensionScore;
  /** 上一次检查的维度分（覆盖写前从旧快照抢救出来的，供「上次 → 本次」对比；仅 inspect） */
  previousScore?: { score: number; generatedAt: string };
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
export function normalizeGuardSource(
  guard: GuardReport | RuleEngineReport,
): readonly DiagnosticEntry[] {
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
export function normalizeInspectSource(
  inspect: InspectionReport | RuleEngineReport,
): readonly DiagnosticEntry[] {
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
function mapViolationSeverity(
  severity: NonNullable<RuleEvaluation['violations']>[number]['severity'],
): DiagnosticSeverity {
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

// 串行化写入队列：并发扫描（guard/inspect/refactor/performance 可并行触发）时
// 保证 latest.json 的写入互不交错，始终以最后一次写入为准。
let writeQueue: Promise<unknown> = Promise.resolve();

/** 诊断条目的来源引擎标识 */
export type DiagnosticSource = DiagnosticEntry['source'];

/**
 * 按域快照目录：`<project>/.zhshield/diagnostics/domains/`。
 *
 * 为什么需要它：`latest.json` 是**整份覆盖写**——谁最后跑，文件里就只有谁的条目
 * （security 跑完，inspect 的条目就没了）。于是任何「读别域结果」的页面都无法
 * 从 latest.json 得到稳定数据，只能自己再触发一次别域检查（越界）。
 * 按域分文件后，各域结果互不覆盖，跨域消费可以「只读结果，不发起检查」。
 */
export function domainSnapshotPath(projectPath: string, source: DiagnosticSource): string {
  return join(projectPath, '.zhshield', 'diagnostics', 'domains', `${source}.json`);
}

/** 写入 <project>/.zhshield/diagnostics/latest.json，返回绝对路径 */
export async function writeDiagnosticsFile(
  report: DiagnosticsReport,
  ranSources: readonly DiagnosticSource[] = [],
): Promise<string> {
  const dir = join(report.project.path, '.zhshield', 'diagnostics');
  const absPath = join(dir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  // 按域拆分快照：同一份报告里可能含多个来源（pipeline 全量落盘），逐个写出
  const perSource = new Map<DiagnosticSource, DiagnosticEntry[]>();
  // 跑过的域先占位（空数组）：**「跑过且 0 检出」必须覆盖写空快照**，
  // 否则磁盘上留着上一次那份「有问题」的快照，界面上已修好的问题永不消失。
  // 只有「这次没跑」的域才保留旧快照 —— 二者语义必须区分。
  for (const source of ranSources) perSource.set(source, []);
  for (const entry of report.issues) {
    const bucket = perSource.get(entry.source);
    if (bucket) bucket.push(entry);
    else perSource.set(entry.source, [entry]);
  }
  // 排队执行，避免并发扫描时多次 writeFile 交错覆盖
  writeQueue = writeQueue.then(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(absPath, payload, 'utf-8');
    if (perSource.size === 0) return;
    await mkdir(join(dir, 'domains'), { recursive: true });
    // 各域快照彼此独立 → 并行写，不做串行 await
    const writes: Promise<void>[] = [];
    for (const [source, issues] of perSource) {
      const snapshot = buildDiagnosticsReport(report.project, issues, report.generatedAt);
      // 巡检跑完当场出分：quality 维评分与报告中心汇总共用 @zh/scoring 的
      // buildHealthDimensions（error -8 / warning -4 / info -1，下限 0），
      // 不引入第三套算法；0 检出 → 100 分同样覆盖写。
      if (source === 'inspect') {
        const [quality] = buildHealthDimensions(null, { issues: issues.map((e) => ({ severity: e.severity, category: e.category })) });
        if (quality?.name === 'quality' && quality.status) {
          snapshot.dimensionScore = {
            dimension: 'quality',
            score: quality.score,
            issues: quality.issues,
            status: quality.status,
            version: SCORE_VERSION,
          };
        }
        // 「上次 → 本次」对比：覆盖写会把旧分抹掉，先从旧快照里抢救出上一轮的
        // dimensionScore（generatedAt 不同才算是另一轮检查；相同说明是同轮重复落盘）。
        // 算法版本不同（v1 快照无 version 字段）→ 不带 previousScore，
        // UI 不显示对比行（跨版本分数不可比，scoreVersion 2 口径）。
        try {
          const oldRaw = await readFile(domainSnapshotPath(report.project.path, source), 'utf-8');
          const old = JSON.parse(oldRaw) as {
            generatedAt?: string;
            dimensionScore?: { score: number; version?: number };
          };
          if (
            old.dimensionScore &&
            typeof old.dimensionScore.score === 'number' &&
            old.dimensionScore.version === SCORE_VERSION &&
            old.generatedAt &&
            old.generatedAt !== report.generatedAt
          ) {
            snapshot.previousScore = {
              score: old.dimensionScore.score,
              generatedAt: old.generatedAt,
            };
          }
        } catch {
          // 旧快照不存在/损坏 → 无对比基线，静默跳过
        }
      }
      writes.push(
        writeFile(
          domainSnapshotPath(report.project.path, source),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf-8',
        ),
      );
    }
    await Promise.all(writes);
  });
  await writeQueue;
  return absPath;
}

/**
 * 读取某治理域最近一次落盘快照（跨域**只读**消费入口）。
 *
 * 缺失 / 损坏 / 结构不符 → 返回 null，由调用方显式提示「无可用快照」，
 * 不得静默当成「该域无问题」。
 */
export async function readDomainSnapshot(
  projectPath: string,
  source: DiagnosticSource,
): Promise<DiagnosticsReport | null> {
  try {
    const raw = await readFile(domainSnapshotPath(projectPath, source), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isDiagnosticsReport(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 最小结构校验：快照必须带 version/project/issues 数组 */
function isDiagnosticsReport(value: unknown): value is DiagnosticsReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DiagnosticsReport>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.project === 'object' &&
    candidate.project !== null &&
    Array.isArray(candidate.issues)
  );
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
export async function persistDiagnostics(
  projectPath: string,
  report: PipelineReport,
): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const issues = filterWhitelisted(whitelist, normalizePipelineReport(report));
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    issues,
    new Date().toISOString(),
  );
  // PipelineReport 的 guard/inspect/refactor 为可选字段：**字段存在 = 该域跑过**。
  const ranSources: DiagnosticSource[] = [];
  if (report.guard) ranSources.push('guard');
  if (report.inspect) ranSources.push('inspect');
  if (report.refactor) ranSources.push('refactor');
  return await writeDiagnosticsFile(diagnostics, ranSources);
}

/**
 * 用已归一化的 entries 直接落盘。
 * 供 runInspect/runGuard/runRefactor/runPerformance 单独扫描时复用，
 * 避免每次单独扫描都走 PipelineReport 形状。
 */
export async function persistDiagnosticsFromEntries(
  projectPath: string,
  entries: readonly DiagnosticEntry[],
  ranSources: readonly DiagnosticSource[],
): Promise<string> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  const diagnostics = buildDiagnosticsReport(
    { path: projectPath, name: basename(projectPath) },
    filterWhitelisted(whitelist, entries),
    new Date().toISOString(),
  );
  return await writeDiagnosticsFile(diagnostics, ranSources);
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

/** techdebt 引擎：未处理（pending/planned/in-progress）债务动作 → 落盘条目 */
export function normalizeTechDebtSource(data: TechDebtReportData): readonly DiagnosticEntry[] {
  const UNPROCESSED: ReadonlySet<string> = new Set(['pending', 'planned', 'in-progress']);
  return data.actionList
    .filter((action) => UNPROCESSED.has(action.status))
    .map((action) => ({
      ruleId: `debt:${action.actionId}`,
      severity: 'warning',
      category: `techdebt:${action.category}`,
      message: `${action.module} 债务项估价 ${action.principalEstimate}，ROI ${action.roi}${action.recommended ? '（推荐优先处理）' : ''}`,
      file: '',
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
