// zhshield CLI 命令实现层：guard / inspect / refactor / pipeline / baseline 五个子命令
// 的执行、报告落盘与降级护栏。自 index.ts 原样抽出（仅搬移，无逻辑改动）；
// index.ts 保留参数解析（parseFlags 长方法基线）与 main/runPipeline 主流程调度。

import {
  loadGuardConclusions,
  runDomains,
  formatDomainRecord,
  SCAN_CHAIN_DOMAINS,
  type PipelineRunner,
  type DomainRunLedger,
  type DomainRunOptions,
} from '@zh/pipeline';
// 扫描类命令的统一收尾：门禁判定必须在 process.exit 之前 —— 命令自行 exit 会让门禁永不可达
import { finalizeScan } from './sop-banner';
import {
  buildFindings,
  toSarif,
  formatReportJson,
  severityRank,
  failOnRank,
  type ConsoleReporter,
  type Finding,
  type FailOn,
} from '@zh/reporter';
import {
  issuesToBaselineEntries,
  saveBaseline,
  loadBaseline,
  clearBaseline,
  baselinePath,
  baselineEntryKey,
  isBaselineEntryActive,
  saveRefactorBaseline,
  clearRefactorBaseline,
  refactorBaselinePath,
} from '@zh/shared';
import { countSmellsByFileAndRule } from '@zh/refactor';
import * as path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { countDegraded } from './degraded';
import type { CLIOptions } from './cli-options';

function shouldBlock(
  report: unknown,
  failOn: FailOn,
  dryRun: boolean,
  projectDir: string,
): { findings: Finding[]; blocked: boolean } {
  const findings = buildFindings(report);
  relativizeFindings(findings, projectDir);
  const blocked =
    !dryRun &&
    failOn !== 'none' &&
    findings.some((f) => severityRank(f.severity) >= failOnRank(failOn));
  return { findings, blocked };
}

/** SARIF artifactLocation 要求仓库相对路径；引擎产出多为绝对路径，
 *  统一转为相对项目根（--dir 解析后的 projectPath），否则 GitHub Code Scanning 无法映射到仓库文件 */
function relativizeFindings(findings: Finding[], projectDir: string): void {
  for (const f of findings) {
    if (f.file && path.isAbsolute(f.file)) {
      f.file = path.relative(projectDir, f.file);
    }
  }
}

/** 可写机器可读报告的命令；各命令报告 schema 不同，默认落盘名必须区分 */
type ReportCommand =
  | 'inspect'
  | 'inspect-sop'
  | 'guard'
  | 'guard-sop'
  | 'refactor'
  | 'pipeline';

/**
 * 各命令的默认报告名基名。
 *
 * 此前四个命令共用 `zhshield.json`：inspect（totalFiles/issues）、refactor
 * （totalSmells）、guard（results）三套 schema 写同一路径，后跑的覆盖先跑的，
 * 用户拿到的「最近一次报告」可能根本不是刚跑的命令。inspect 保留 zhshield.json
 * 是因为 MCP 首次引导回退读该文件（desktop/electron/zhshield-mcp.ts），改名会断。
 *
 * `--sop` 分支产出的是 RuleEngineReport（evaluations/degraded），与默认路径的
 * InspectionReport / GuardReport 是**不同 schema**。放进同名文件会让解析方
 * （CI 脚本、MCP）静默拿到错字段（如 `issues` 不存在 → 误判零问题），故单独命名。
 */
const DEFAULT_REPORT_BASE: Record<ReportCommand, string> = {
  inspect: 'zhshield',
  'inspect-sop': 'zhshield-sop',
  guard: 'zhshield-guard',
  'guard-sop': 'zhshield-guard-sop',
  refactor: 'zhshield-refactor',
  pipeline: 'zhshield-pipeline',
};

/** 报告落盘目标：项目根与命令合为一个上下文，避免函数参数列表过长 */
interface ReportTarget {
  projectDir: string;
  command: ReportCommand;
}

/** 机器可读报告落盘。父目录不存在时递归创建——CI 传 reports/xxx.json
 *  不应要求预建目录，裸抛 ENOENT 会把产物链路变成难排查的崩溃栈。 */
function writeReportFile(
  opts: CLIOptions,
  report: unknown,
  findings: Finding[],
  target: ReportTarget,
): void {
  const { projectDir, command } = target;
  const base = DEFAULT_REPORT_BASE[command];
  if (opts.format === 'sarif') {
    const outPath = opts.report || `${base}.sarif`;
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, toSarif(findings), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  if (opts.format === 'json') {
    const outPath = opts.report || `${base}.json`;
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, formatReportJson(report), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  // text 或未知格式：不写机器可读文件
}

/** 输出错误报告并退出 */
export function handleError(reporter: ConsoleReporter, err: unknown): void {
  console.error(
    reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: null,
      refactor: null,
      passed: false,
      stage: 'complete',
      error: err instanceof Error ? err.message : String(err),
    }).text,
  );
  process.exit(1);
}

/** P0（复查4）降级护栏（全路径统一）：degraded > 0 → 告警 + exit 2。
 *  此前该判定只存在于 --sop 分支，默认路径 8 项全跳过仍 100 分通过（盲检）。 */
function applyDegradedGuard(report?: unknown, subReports?: unknown[]): void {
  const degraded = subReports
    ? subReports.reduce<number>((n, r) => n + countDegraded(r), 0)
    : countDegraded(report);
  if (degraded > 0) {
    console.error(
      `[CLI] 降级警告: ${degraded} 项检查未实际执行（工具不可用/引擎缺失）—— 未检测 ≠ 通过，按门禁失败处理（exit 2）。`,
    );
    process.exitCode = 2;
  }
}

export async function runGuardCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    // 《07》A6：门禁是纯判定域，只读各供应商域已落盘的结论，不自行派发工具。
    // CLI 自身尚无域快照写入能力，故仅当存在快照时才注入；否则沿用 kernel 明示的
    // 历史工具派发兼容边界，并提示用户先跑对应域，避免「注入空结论集 → 全 skipped → 静默放行」。
    const conclusions = await loadGuardConclusions(projectDir);
    const hasConclusions = Object.keys(conclusions).length > 0;
    if (!hasConclusions) {
      console.error(
        '[CLI] 未发现供应商域快照（inspect/security/deps 均未落盘），门禁退回工具派发模式；如需只读判定请先运行对应域。',
      );
    }
    const report = await runner.runSopGuard(
      hasConclusions ? { dryRun: opts.dryRun, conclusions } : { dryRun: opts.dryRun },
    );
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    writeReportFile(opts, report, findings, { projectDir, command: 'guard-sop' });
    applyDegradedGuard(report);
    finalizeScan(runner, opts, blocked);
  } else {
    const report = await runner.runGuard({ dryRun: opts.dryRun });
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: report,
      inspect: null,
      refactor: null,
      passed: !blocked,
      stage: 'guard',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings, { projectDir, command: 'guard' });
    applyDegradedGuard(report);
    finalizeScan(runner, opts, blocked);
  }
}

export async function runInspectCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopInspect();
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
    writeReportFile(opts, report, findings, { projectDir, command: 'inspect-sop' });
    applyDegradedGuard(report);
    finalizeScan(runner, opts, blocked);
  } else {
    const report = await runner.runInspect();
    const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: report,
      refactor: null,
      passed: !blocked,
      stage: 'inspect',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings, { projectDir, command: 'inspect' });
    applyDegradedGuard(report);
    finalizeScan(runner, opts, blocked);
  }
}

export async function runRefactorCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  const report = await runner.runRefactor();
  const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
  // 注：refactor 是纯 AST 静态分析、不依赖外部工具，无"检查未实际执行"的降级场景
  // （countDegraded 对 RefactorReport 恒为 0），故此处有意不调 applyDegradedGuard。
  const formatted = reporter.format({
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: report,
    passed: !blocked,
    stage: 'refactor',
  });
  console.log(formatted.text);
  writeReportFile(opts, report, findings, { projectDir, command: 'refactor' });
  finalizeScan(runner, opts, blocked);
}

/** baseline capture：直扫 + SOP 双源合并、按匹配键去重后落基线 */
async function baselineCapture(runner: PipelineRunner, projectDir: string): Promise<void> {
  const report = await runner.runInspect({ skipBaseline: true });
  const sopReport = await runner.runSopInspect(undefined, { skipBaseline: true });
  const sopViolations = sopReport.evaluations.flatMap((ev) => ev.violations ?? []);
  // 两个来源可能产出同一条（直扫与 SOP 规则重叠），按匹配键去重避免基线里出现重复条目
  const merged = [
    ...issuesToBaselineEntries(report.issues, projectDir),
    ...issuesToBaselineEntries(sopViolations, projectDir),
  ];
  const seen = new Set<string>();
  const entries = merged.filter((e) => {
    const key = baselineEntryKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const saved = await saveBaseline(projectDir, entries);
  console.log(
    `基线已捕获: ${entries.length} 项问题（直扫 ${report.issues.length} + SOP ${sopViolations.length}，去重后 ${entries.length}）→ ${baselinePath(projectDir)} (${saved.capturedAt})`,
  );
  console.log('提示：带 reason/owner/expiresAt 的条目才是可审计豁免，建议手工补齐后再入库');
  process.exit(process.exitCode);
}

/** baseline list：打印基线条目、理由/责任人/到期与过期状态 */
async function baselineList(projectDir: string): Promise<void> {
  const baseline = await loadBaseline(projectDir);
  if (!baseline) {
    console.log('尚未捕获基线（无 .zhshield/baseline.json）');
    process.exit(0);
  }
  const expired = baseline.entries.filter((e) => !isBaselineEntryActive(e)).length;
  console.log(`基线 ${baseline.entries.length} 项，捕获于 ${baseline.capturedAt}`);
  if (expired > 0) {
    console.log(`其中 ${expired} 项已过期失效（不参与豁免，问题会重新计入报告）`);
  }
  for (const entry of baseline.entries) {
    const state = isBaselineEntryActive(entry) ? '' : '  [已过期]';
    const reason = entry.reason ? `  理由: ${entry.reason}` : '  [未记录理由]';
    const owner = entry.owner ? `  责任人: ${entry.owner}` : '';
    const expires = entry.expiresAt ? `  到期: ${entry.expiresAt}` : '  [永久]';
    console.log(
      `  ${entry.ruleId}  ${entry.file}:${entry.line}:${entry.column}${state}${reason}${owner}${expires}`,
    );
  }
  process.exit(process.exitCode);
}

async function baselineClear(projectDir: string): Promise<void> {
  await clearBaseline(projectDir);
  console.log(`基线已清除: ${baselinePath(projectDir)}`);
  process.exit(process.exitCode);
}

/** baseline capture-refactor：skipBaseline 捕获全量报告（否则存量被已有基线压掉，棘轮收不进新存量） */
async function baselineCaptureRefactor(runner: PipelineRunner, projectDir: string): Promise<void> {
  const report = await runner.runRefactor({ skipBaseline: true });
  const counts = countSmellsByFileAndRule(report, projectDir);
  const fileCount = Object.keys(counts).length;
  const saved = await saveRefactorBaseline(projectDir, counts);
  console.log(
    `重构棘轮基线已捕获: ${report.totalSmells} 处存量异味（${fileCount} 个文件）→ ${refactorBaselinePath(projectDir)} (${saved.capturedAt})`,
  );
  console.log('提示：此后 refactor 报告只显示超出基线的增量；修复存量后可重新捕获收紧棘轮');
  process.exit(process.exitCode);
}

async function baselineClearRefactor(projectDir: string): Promise<void> {
  await clearRefactorBaseline(projectDir);
  console.log(`重构棘轮基线已清除: ${refactorBaselinePath(projectDir)}`);
  process.exit(process.exitCode);
}

export async function runBaselineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  _reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  switch (opts.baselineAction) {
    case 'capture':
      return baselineCapture(runner, projectDir);
    case 'list':
      return baselineList(projectDir);
    case 'clear':
      return baselineClear(projectDir);
    case 'capture-refactor':
      return baselineCaptureRefactor(runner, projectDir);
    case 'clear-refactor':
      return baselineClearRefactor(projectDir);
  }
  console.error('未知 baseline 子命令，支持: capture | list | clear | capture-refactor | clear-refactor');
  process.exit(1);
}

/** 全量扫描命令的注入缝：单测替换域驱动，避免真跑外部工具 */
export interface FullScanDeps {
  runDomains?: (options: DomainRunOptions) => Promise<DomainRunLedger>;
}

/**
 * `pipeline --full`：全量扫描链（《07》A12/A13/A15）。
 *
 * 与桌面端、无头脚本共用 `runDomains` 的同一批执行器与同一份逐域账本 ——
 * 这是"全量主链路"在 CLI 侧的入口，不再自行拼 guard/inspect 两段编排。
 *
 * 不含门禁判定：guard 是纯判定域，只读各域已落盘结论（O8/A6）。CLI 本轮不落域快照，
 * 把 guard 放进扫描链会在无快照时退回工具派发，反而让同一工具跑第二次（A12）。
 *
 * 退出码：任一域 `unavailable`/`partial` → 2（未检测 ≠ 通过）；`not-run`（techdebt
 * 需宿主注入）不算失败，如实打印原因即可（C4/C5）。
 */
export async function runFullScanCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  projectDir: string,
  deps: FullScanDeps = {},
): Promise<void> {
  const run = deps.runDomains ?? runDomains;
  const ledger = await run({
    repoRoot: projectDir,
    domains: SCAN_CHAIN_DOMAINS,
    runner,
  });

  for (const record of ledger.records) console.log(formatDomainRecord(record));
  console.log(
    `[CLI] 全量扫描完成：${ledger.records.length} 域，sumMs=${ledger.sumMs} / wallMs=${ledger.wallMs}（并发 ${ledger.concurrency}）`,
  );

  if (opts.format === 'json') {
    const outPath = opts.report || 'zhshield-scan-ledger.json';
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    console.error(`[CLI] 账本已写入: ${outPath}`);
  }

  const incomplete = ledger.records.filter(
    (record) => record.status === 'unavailable' || record.status === 'partial',
  );
  if (incomplete.length > 0) {
    const detail = incomplete.map((record) => `${record.domain}(${record.status})`).join('、');
    console.error(`[CLI] 全量扫描有 ${incomplete.length} 个域未完成：${detail} — 未检测 ≠ 通过（exit 2）`);
    process.exitCode = 2;
  }
}

export async function runPipelineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
  deps: FullScanDeps = {},
): Promise<void> {
  // --full：走按域驱动的全量扫描链（与桌面端、无头脚本同一批执行器）
  if (opts.full) {
    await runFullScanCommand(runner, opts, projectDir, deps);
    return;
  }

  const report = opts.sop
    ? await runner.runSopDrivenPipeline()
    : await runner.runFullPipeline({ dryRun: opts.dryRun });

  const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
  const formatted = reporter.format(report);
  console.log(formatted.text);
  writeReportFile(opts, report, findings, { projectDir, command: 'pipeline' });
  applyDegradedGuard(undefined, [report.guard, report.inspect]);
  finalizeScan(runner, opts, blocked);
}
