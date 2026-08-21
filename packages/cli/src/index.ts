#!/usr/bin/env tsx
/**
 * zhshield — 智汇码盾命令行入口
 *
 * 用法:
 *   tsx packages/cli/src/index.ts guard [--dir <path>] [--dry-run]
 *   tsx packages/cli/src/index.ts inspect [--dir <path>]
 *   tsx packages/cli/src/index.ts refactor [--dir <path>]
 *   tsx packages/cli/src/index.ts pipeline [--dir <path>] [--dry-run] [--sop]
 *   tsx packages/cli/src/index.ts deps [--dir <path>] [--sbom <out.json>] [--json]
 *   tsx packages/cli/src/index.ts help
 */
import { buildDependencyGraph, toCycloneDX, buildLicenseMatrix, TyposquatDetectorImpl, lockfileVerifier, EnvConsistencyCheckerImpl } from '@zh/dependency';
import { appendGuardReport, toGuardReportRecord } from '@zh/guard';
import { PipelineRunner, createReport, detectProjectProfile } from '@zh/pipeline';
import { ConsoleReporter } from '@zh/reporter';
import { initI18n, resolveLanguage, t, type LanguageCode } from '@zh/i18n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOOK_ARG_RE = /^--hook=(.+)$/;

/** 布尔开关类参数：出现即置位，不消费后续取值 */
const BOOLEAN_FLAGS: Record<string, (opts: CLIOptions) => void> = {
  '--staged': (o) => { o.staged = true; },
  '--dry-run': (o) => { o.dryRun = true; },
  '--sop': (o) => { o.sop = true; },
  '--verbose': (o) => { o.verbose = true; },
  '--no-color': (o) => { o.color = false; },
  '--json': (o) => { o.json = true; },
  '--help': (o) => { o.help = true; },
  help: (o) => { o.help = true; },
};

/** 取值类参数：消费下一个参数作为值（缺失时保持默认） */
const VALUE_FLAGS: Record<string, (opts: CLIOptions, value?: string) => void> = {
  '--dir': (o, v) => { o.dir = v || o.dir; },
  '--hook': (o, v) => { o.hook = v || undefined; },
  '--sbom': (o, v) => { o.sbom = v || undefined; },
  '--lang': (o, v) => { o.lang = v || undefined; },
};

/**
 * 语言解析优先级：--lang > ZH_LANG / 系统环境语言 > 默认（zh-Hans）。
 * detectLanguageFromEnv 未从 @zh/i18n 的 index 导出，此处内联其取值逻辑。
 */
function resolveCliLanguage(explicit?: string): LanguageCode {
  const env = process.env.ZH_LANG ?? process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? null;
  return resolveLanguage(explicit, env).value;
}

function printUsage(): void {
  const cmd = (name: string, descKey: string) => `  ${name.padEnd(29)}${t(descKey)}`;
  const opt = (flag: string, descKey: string) => `  ${flag.padEnd(17)}${t(descKey)}`;
  console.log([
    '',
    t('cli.title'),
    '',
    t('cli.usageTitle'),
    cmd('zhshield guard [options]', 'cli.command.guard'),
    cmd('zhshield inspect [options]', 'cli.command.inspect'),
    cmd('zhshield refactor [options]', 'cli.command.refactor'),
    cmd('zhshield pipeline [options]', 'cli.command.pipeline'),
    cmd('zhshield deps [options]', 'cli.command.deps'),
    cmd('zhshield help', 'cli.command.help'),
    '',
    t('cli.optionsTitle'),
    opt('--dir <path>', 'cli.option.dir'),
    opt('--hook <name>', 'cli.option.hook'),
    opt('--staged', 'cli.option.staged'),
    opt('--dry-run', 'cli.option.dryRun'),
    opt('--sop', 'cli.option.sop'),
    opt('--verbose', 'cli.option.verbose'),
    opt('--no-color', 'cli.option.noColor'),
    opt('--lang <code>', 'cli.option.lang'),
    opt('--sbom <path>', 'cli.option.sbom'),
    opt('--json', 'cli.option.json'),
    '',
  ].join('\n'));
}

interface CLIOptions {
  command: string;
  dir: string;
  dryRun: boolean;
  sop: boolean;
  verbose: boolean;
  color: boolean;
  help: boolean;
  hook?: string;
  staged: boolean;
  sbom?: string;
  json: boolean;
  lang?: string;
}

export function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    command: '',
    dir: process.cwd(),
    dryRun: false,
    sop: false,
    verbose: false,
    color: true,
    help: false,
    staged: false,
    json: false,
  };

  const args = argv.slice(2);
  if (args.length === 0) {
    opts.help = true;
    return opts;
  }

  opts.command = args[0];
  if (opts.command === 'help') {
    opts.help = true;
  }

  let i = 1;
  while (i < args.length) {
    i += applyArg(opts, args, i);
  }

  return opts;
}

/**
 * 解析单个参数并返回其占用的参数个数（含自身）。
 * 返回值：1 = 普通参数；2 = 消费了下一个参数作为取值（如 --dir <path>）。
 */
function applyArg(opts: CLIOptions, args: string[], index: number): number {
  const eqHook = args[index].match(HOOK_ARG_RE);
  if (eqHook) {
    opts.hook = eqHook[1];
    return 1;
  }

  const valueSetter = VALUE_FLAGS[args[index]];
  if (valueSetter) {
    valueSetter(opts, args[index + 1]);
    return 2;
  }

  const booleanSetter = BOOLEAN_FLAGS[args[index]];
  if (booleanSetter) {
    booleanSetter(opts);
  }
  return 1;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const lng = resolveCliLanguage(opts.lang);
  initI18n({ lng });
  if (isHelpRequest(opts)) {
    printUsage();
    process.exit(0);
  }

  await runCli(opts, lng);
}

function isHelpRequest(opts: CLIOptions): boolean {
  return opts.help || opts.command === 'help';
}

async function runCli(opts: CLIOptions, lng: LanguageCode): Promise<void> {
  const reporter = new ConsoleReporter({ color: opts.color, verbose: opts.verbose, lang: lng });

  try {
    // deps 是纯静态解析，无需初始化流水线引擎（避免 SOP 加载日志污染 --json 输出）
    if (opts.command === 'deps') {
      await runDepsCommand(opts);
      return;
    }

    const runner = new PipelineRunner(opts.dir);
    await logLoadedRules(runner);
    await runCommand(runner, opts, reporter);
    await runner.destroy();
  } catch (err: unknown) {
    reportFatalError(reporter, err);
  }
}

async function logLoadedRules(runner: PipelineRunner): Promise<void> {
  const ruleCount = await runner.loadSopRules();
  console.error(`[CLI] 已加载 ${ruleCount} 条 SOP 规则\n`);
}

function reportFatalError(reporter: ConsoleReporter, err: unknown): void {
  console.error(reporter.format(createReport({
    stage: 'complete',
    passed: false,
    error: err instanceof Error ? err.message : String(err),
  })).text);
  process.exit(1);
}

async function runCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  switch (opts.command) {
    case 'guard': await runGuardCommand(runner, opts, reporter); break;
    case 'inspect': await runInspectCommand(runner, opts, reporter); break;
    case 'refactor': await runRefactorCommand(runner, reporter); break;
    case 'pipeline': await runPipelineCommand(runner, opts, reporter); break;
    default:
      console.error(`未知命令: ${opts.command}`);
      printUsage();
      process.exit(1);
  }
}

async function runGuardCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopGuard({ dryRun: opts.dryRun });
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    process.exit(formatted.passed ? 0 : 1);
  }

  // pre-commit hook：暂存区无变更时直接放行，不触发全量检查
  if (opts.staged && hasNoStagedChanges()) {
    console.log('✅ 暂存区无变更，门禁检查跳过');
    process.exit(0);
  }

  const report = await runner.runGuard({
    dryRun: opts.dryRun,
    triggerSource: opts.hook,
  });
  try {
    appendGuardReport(opts.dir, toGuardReportRecord(report, opts.hook ?? 'manual'));
  } catch {
    // 报告落库失败不阻断门禁主流程（git hooks 中不能因记录失败放行/拦截失效）
  }
  const formatted = reporter.format(createReport({
    guard: report,
    passed: report.ok !== false,
    stage: 'guard',
  }));
  console.log(formatted.text);
  process.exit(formatted.passed ? 0 : 1);
}

function hasNoStagedChanges(): boolean {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync('git diff --cached --name-only', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

async function runInspectCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopInspect();
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    process.exit(formatted.passed ? 0 : 1);
  } else {
    const report = await runner.runInspect();
    const formatted = reporter.format(createReport({
      inspect: report,
      passed: true,
      stage: 'inspect',
    }));
    console.log(formatted.text);
    process.exit(0);
  }
}

async function runRefactorCommand(runner: PipelineRunner, reporter: ConsoleReporter): Promise<void> {
  const report = await runner.runRefactor();
  const formatted = reporter.format(createReport({
    refactor: report,
    passed: true,
    stage: 'refactor',
  }));
  console.log(formatted.text);
  process.exit(0);
}

async function runPipelineCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopDrivenPipeline();
    const formatted = reporter.format(report);
    console.log(formatted.text);
    process.exit(formatted.passed ? 0 : 1);
  } else {
    const report = await runner.runFullPipeline({
      dryRun: opts.dryRun,
    });
    const formatted = reporter.format(report);
    console.log(formatted.text);
    process.exit(formatted.passed ? 0 : 1);
  }
}

/**
 * deps 子命令：依赖管家。
 * 调用 @zh/dependency 构建依赖图谱，支持 --json 输出完整图谱、
 * --sbom 导出 CycloneDX SBOM 到文件，默认输出人类可读的许可矩阵报告。
 * 纯静态解析，不依赖 PipelineRunner。
 */
async function runDepsCommand(opts: CLIOptions): Promise<void> {
  const graph = buildDependencyGraph(opts.dir, { targetId: opts.dir });

  if (opts.json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  if (opts.sbom) {
    try {
      fs.mkdirSync(path.dirname(opts.sbom), { recursive: true });
      fs.writeFileSync(opts.sbom, `${JSON.stringify(toCycloneDX(graph), null, 2)}\n`, 'utf-8');
    } catch (err: unknown) {
      console.error(`❌ SBOM 写入失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log(`✅ SBOM 已写入: ${opts.sbom}`);
    return;
  }

  if (graph.nodes.length === 0) {
    console.log('依赖管家: 未发现依赖清单（package-lock.json / pnpm-lock.yaml / yarn.lock / requirements.txt / pyproject.toml / Pipfile.lock / poetry.lock）');
    return;
  }

  const direct = graph.nodes.filter((n) => n.kind === 'direct').length;
  const transitive = graph.nodes.filter((n) => n.kind === 'transitive').length;
  const matrix = buildLicenseMatrix(graph);
  const highRisk = matrix.entries.filter((entry) => entry.risk === 'high');

  console.log('── 依赖管家 ──');
  console.log(`项目: ${opts.dir}`);
  console.log(`生态: ${graph.ecosystem}`);
  const lockfileLabel = graph.lockfile.present
    ? `✓ 存在（${graph.lockfile.consistent ? '一致性已校验' : '一致性未校验'}）`
    : '✗ 缺失';
  console.log(`锁文件: ${lockfileLabel}`);
  console.log(`依赖总数: ${graph.nodes.length}（直接 ${direct} / 传递 ${transitive}）`);
  console.log('');
  console.log('── 许可矩阵 ──');
  console.log(`permissive: ${matrix.byCategory.permissive} (低风险)`);
  console.log(`weak-copyleft: ${matrix.byCategory['weak-copyleft']} (中风险)`);
  console.log(`strong-copyleft: ${matrix.byCategory['strong-copyleft']} (高风险)`);
  console.log(`unknown: ${matrix.byCategory.unknown} (中风险 — 需人工确认)`);
  if (highRisk.length > 0) {
    const highRiskList = highRisk
      .map((entry) => `${entry.name}@${entry.version} (${entry.license || 'unknown'})`)
      .join(', ');
    console.log(`高风险许可: ${highRiskList}`);
  }
  console.log('');
  console.log('── 直接依赖 ──');
  for (const node of graph.nodes.filter((n) => n.kind === 'direct')) {
    const range = node.declaredRange ? ` (${node.declaredRange})` : '';
    console.log(`• ${node.name}@${node.version}${range} [${node.license || 'unknown'}, ${node.trust}]`);
  }
  console.log('');
  console.log('── 投毒检测 ──');
  try {
    const typosquatFindings = await new TyposquatDetectorImpl().detect(graph);
    if (typosquatFindings.length === 0) {
      console.log('未发现可疑的投毒依赖（typosquatting）');
    } else {
      for (const finding of typosquatFindings) {
        const target = finding.signals.nameSimilarity?.target ?? '未知知名包';
        console.log(`• ${finding.nodeId} [${finding.risk}] 与知名包 ${target} 相似`);
        for (const item of finding.evidence) {
          console.log(`    - ${item}`);
        }
      }
    }
  } catch (err: unknown) {
    console.log(`✗ 投毒检测失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');
  console.log('── 锁文件校验 ──');
  try {
    const verification = await lockfileVerifier.verify(opts.dir);
    if (verification.status === 'clean') {
      console.log('✓ 校验通过：声明与锁定一致，完整性完好');
    } else if (verification.status === 'modified') {
      console.log(`✗ 发现不一致：${verification.diffs.length} 处声明差异 / ${verification.integrityFailures.length} 处完整性异常`);
      for (const diff of verification.diffs) {
        console.log(`    - ${diff.name}: 声明 ${diff.declaredVersion} → 锁定 ${diff.lockedVersion || '缺失'}`);
      }
      for (const failure of verification.integrityFailures) {
        console.log(`    - ${failure}`);
      }
    } else {
      console.log('✗ 未发现锁文件');
    }
  } catch (err: unknown) {
    console.log(`✗ 锁文件校验失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');
  console.log('── 环境一致性 ──');
  try {
    const envReport = await new EnvConsistencyCheckerImpl().check(detectProjectProfile(opts.dir));
    const envErrors = envReport.entries.filter((entry) => entry.severity === 'error').length;
    const envWarnings = envReport.entries.filter((entry) => entry.severity === 'warning').length;
    if (envReport.entries.length === 0) {
      console.log('未发现环境偏差');
    } else {
      console.log(`发现 ${envErrors} 处阻断性偏差 / ${envWarnings} 处提示（共 ${envReport.entries.length} 条）`);
      for (const entry of envReport.entries) {
        console.log(`• [${entry.severity}] ${entry.name}: ${entry.detail}`);
      }
    }
  } catch (err: unknown) {
    console.log(`✗ 环境一致性检查失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 直接执行本文件时启动 CLI；被测试等模块导入时不触发 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
