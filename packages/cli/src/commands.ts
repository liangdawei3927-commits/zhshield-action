// zhshield CLI 命令实现层：guard / inspect / refactor / pipeline / baseline 五个子命令
// 的执行、报告落盘与降级护栏。自 index.ts 原样抽出（仅搬移，无逻辑改动）；
// index.ts 保留参数解析（parseFlags 长方法基线）与 main/runPipeline 主流程调度。

import {
  loadGuardConclusions,
  runDomains,
  runCveChecks,
  formatDomainRecord,
  SCAN_CHAIN_DOMAINS,
  type PipelineRunner,
  type DomainRunLedger,
  type DomainRunOptions,
} from '@zh/pipeline';
// 扫描类命令的统一收尾：门禁判定必须在 process.exit 之前 —— 命令自行 exit 会让门禁永不可达
import { finalizeScan } from './sop-banner';
import { type ConsoleReporter } from '@zh/reporter';
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
  INSPECT_SCOPE_DOMAINS,
} from '@zh/shared';
// 注：@zh/refactor（会传递引入 TypeScript 编译器，体量大）不在模块顶层静态 import，
// 仅在 baselineCaptureRefactor 里按需动态 import —— 避免「打印用法 / guard / inspect」
// 等常用命令的冷启动被迫加载整套重构引擎（实测会拖慢 CLI 入口，影响命令路由测试）。
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { applyDegradedGuard, shouldBlock, writeReportFile } from './command-support';
import { runGuardHookCommand } from './guard-hook';
import type { CLIOptions } from './cli-options';
import {
  asGovernanceDomains,
  domainsMisapplied,
  parseDomainList,
  SOP_DOMAIN_HINT,
} from './domain-args';

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

export async function runGuardCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (domainsMisapplied(opts)) return;
  if (opts.hook) {
    await runGuardHookCommand({ runner, opts, reporter, projectDir, hook: opts.hook });
    return;
  }
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
  if (domainsMisapplied(opts)) return;
  if (opts.sop) {
    // `--domains`：SOP 链路的真正收敛手段。不带域过滤的 --sop 是「三域合并一次评估」的历史
    // 单体路径（无域预算、无硬超时，实测 85 条规则下 4 分 22 秒仍未结束），按域收窄可直接避开。
    const domains = opts.domains
      ? parseDomainList(opts.domains, INSPECT_SCOPE_DOMAINS, SOP_DOMAIN_HINT)
      : undefined;
    if (domains === null) {
      process.exitCode = 1;
      return;
    }
    const report = await runner.runSopInspect(
      domains ? { domains: asGovernanceDomains(domains) } : undefined,
    );
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
  if (domainsMisapplied(opts)) return;
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
  const { countSmellsByFileAndRule } = await import('@zh/refactor');
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
  console.error(
    '未知 baseline 子命令，支持: capture | list | clear | capture-refactor | clear-refactor',
  );
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
 *
 * `--domains` 只跑指定子集：这是 C5「单域可独立运行」在 CLI 侧的唯一入口，
 * 也是验收脚本（`verify-offline-deps` / `verify-tool-dedup`）能用几秒跑完的前提。
 */
export async function runFullScanCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  projectDir: string,
  deps: FullScanDeps = {},
): Promise<void> {
  const requested = opts.domains ? parseDomainList(opts.domains) : undefined;
  if (requested === null) {
    process.exitCode = 1;
    return;
  }
  const run = deps.runDomains ?? runDomains;
  const ledger = await run({
    repoRoot: projectDir,
    domains: requested ?? SCAN_CHAIN_DOMAINS,
    runner,
    // 依赖域 CVE：与桌面端共用同一份 OSV 查询（O10）。不可达时域记 partial 并 exit 2，
    // 绝不把「没查成」折算成 0 漏洞（C4/A15）。
    depsScanInput: { cveProvider: (nodes) => runCveChecks(nodes) },
  });

  for (const record of ledger.records) console.log(formatDomainRecord(record));
  console.log(
    `[CLI] 全量扫描完成：${ledger.records.length} 域，sumMs=${ledger.sumMs} / wallMs=${ledger.wallMs}（并发 ${ledger.concurrency}）`,
  );

  if (opts.format === 'json') {
    const outPath = opts.report || 'zhshield-scan-ledger.json';
    const absPath = path.resolve(projectDir, outPath);
    // 异步 fs：本函数为 async 热路径入口，禁止同步 IO 阻塞事件循环（perf-no-sync-fs-hotpath）。
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    console.error(`[CLI] 账本已写入: ${outPath}`);
  }

  const incomplete = ledger.records.filter(
    (record) => record.status === 'unavailable' || record.status === 'partial',
  );
  if (incomplete.length > 0) {
    const detail = incomplete.map((record) => `${record.domain}(${record.status})`).join('、');
    console.error(
      `[CLI] 全量扫描有 ${incomplete.length} 个域未完成：${detail} — 未检测 ≠ 通过（exit 2）`,
    );
    process.exitCode = 2;
  }
}

/** pipeline 命令的宿主上下文：报告器、项目根与可选的域驱动注入 */
export interface PipelineCommandContext {
  reporter: ConsoleReporter;
  projectDir: string;
  /** `--full` 的域驱动注入（单测替换，避免真跑外部工具） */
  fullScanDeps?: FullScanDeps;
}

export async function runPipelineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  ctx: PipelineCommandContext,
): Promise<void> {
  // --full：走按域驱动的全量扫描链（与桌面端、无头脚本同一批执行器）
  if (opts.full) {
    await runFullScanCommand(runner, opts, ctx.projectDir, ctx.fullScanDeps ?? {});
    return;
  }
  if (domainsMisapplied(opts)) return;

  // --sop：历史单体路径，但可用 --domains 收窄到 SOP 能服务的域（避免三域合并无预算长跑）
  const sopDomains = opts.domains
    ? parseDomainList(opts.domains, INSPECT_SCOPE_DOMAINS, SOP_DOMAIN_HINT)
    : undefined;
  if (sopDomains === null) {
    process.exitCode = 1;
    return;
  }

  const report = opts.sop
    ? await runner.runSopDrivenPipeline(
        sopDomains ? { inspectContext: { domains: asGovernanceDomains(sopDomains) } } : undefined,
      )
    : await runner.runFullPipeline({ dryRun: opts.dryRun });

  const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, ctx.projectDir);
  const formatted = ctx.reporter.format(report);
  console.log(formatted.text);
  writeReportFile(opts, report, findings, { projectDir: ctx.projectDir, command: 'pipeline' });
  applyDegradedGuard(undefined, [report.guard, report.inspect]);
  finalizeScan(runner, opts, blocked);
}
