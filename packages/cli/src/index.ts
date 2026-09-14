/**
 * zhshield — 智汇码盾命令行入口
 *
 * 用法:
 *   tsx packages/cli/src/index.ts guard [--dir <path>] [--dry-run]
 *   tsx packages/cli/src/index.ts inspect [--dir <path>]
 *   tsx packages/cli/src/index.ts refactor [--dir <path>]
 *   tsx packages/cli/src/index.ts pipeline [--dir <path>] [--dry-run] [--sop]
 *   tsx packages/cli/src/index.ts help
 */
import { PipelineRunner } from '@zh/pipeline';
import { resolveBundledSopDir } from './sop-dir';
import { ConsoleReporter } from '@zh/reporter';
import {
  buildFindings,
  toSarif,
  formatReportJson,
  severityRank,
  failOnRank,
  type Finding,
  type FailOn,
} from '@zh/reporter';
import {
  augmentProcessPath,
  issuesToBaselineEntries,
  saveBaseline,
  loadBaseline,
  clearBaseline,
  baselinePath,
} from '@zh/shared';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';

// 双模兼容：bundle 为 CJS（esbuild format:'cjs'），__dirname 原生可用；
// 开发态（tsx 以 ESM 运行）__dirname 未声明，typeof 安全返回 undefined，
// 改为从被执行脚本路径（process.argv[1]）推导，避免 import.meta（tsc CommonJS 不支持）。
function resolveBaseDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  const invoked = process.argv[1];
  if (invoked) return path.dirname(path.resolve(invoked));
  return process.cwd();
}
const baseDir = resolveBaseDir();

/** 解析最终项目根目录（projectPath）：--dir 显式给出时按 cwd 解析为绝对路径；
 *  未给出时默认当前工作目录。process.cwd() 作为项目目录默认值的语义仅在此处出现一次，
 *  文件相对化与报告输出均以该解析结果为基准，避免随进程 cwd 漂移。 */
function resolveProjectDir(dir: string): string {
  return dir ? path.resolve(dir) : process.cwd();
}

function printUsage(): void {
  console.log(`
zhshield — 智汇码盾 代码质量治理

用法:
  zhshield guard [options]     执行 Guard 门禁检查
  zhshield inspect [options]   执行 Inspect 巡检
  zhshield refactor [options]  执行 Refactor 重构检测
  zhshield pipeline [options]  执行完整流水线
  zhshield baseline capture [--dir <path>]  捕获当前问题为豁免基线
  zhshield baseline list [--dir <path>]     列出基线条目
  zhshield baseline clear [--dir <path>]    清除基线文件
  zhshield help                显示此帮助

选项:
  --dir <path>    项目根目录（默认: 当前目录）
  --dry-run       Guard 模式：只报告不阻断
  --sop           使用 SOP 规则驱动模式（默认: checks.json 模式）
  --verbose       显示详细信息
  --no-color      禁用颜色输出
  --format <fmt>  报告格式: text(默认) | json | sarif
  --report <path> 机器可读报告输出路径 (json/sarif 时生效)
  --fail-on <lvl> 阻断阈值: guard/refactor/pipeline 默认 error | inspect 默认 none(仅报告) | warning | info
`);
}

interface CLIOptions {
  command: string;
  dir: string;
  dryRun: boolean;
  sop: boolean;
  verbose: boolean;
  color: boolean;
  help: boolean;
  format: 'text' | 'json' | 'sarif';
  report: string;
  failOn: FailOn;
  baselineAction?: 'capture' | 'list' | 'clear';
}

function parseArgs(argv: string[]): CLIOptions {
  const opts = createDefaultOptions();

  const args = argv.slice(2);
  if (args.length === 0) {
    opts.help = true;
    return opts;
  }

  parseCommand(args, opts);
  const explicitFailOn = parseFlags(args, opts);
  applyCommandDefaults(opts, explicitFailOn);

  return opts;
}

function createDefaultOptions(): CLIOptions {
  return {
    command: '',
    dir: '', // 空串哨兵：未传 --dir 时由 resolveProjectDir 兜底为 process.cwd()
    dryRun: false,
    sop: false,
    verbose: false,
    color: true,
    help: false,
    format: 'text',
    report: '',
    failOn: 'error',
  };
}

function parseCommand(args: string[], opts: CLIOptions): void {
  opts.command = args[0];
  if (opts.command === 'help') {
    opts.help = true;
  }
  if (opts.command === 'baseline') {
    opts.baselineAction = (args[1] as CLIOptions['baselineAction']) ?? 'list';
  }
}

function parseFlags(args: string[], opts: CLIOptions): boolean {
  let explicitFailOn = false;
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
        opts.dir = args[++i] || opts.dir;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--sop':
        opts.sop = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--no-color':
        opts.color = false;
        break;
      case '--format':
        opts.format = (args[++i] as CLIOptions['format']) || opts.format;
        break;
      case '--report':
        opts.report = args[++i] || opts.report;
        break;
      case '--fail-on':
        opts.failOn = (args[++i] as FailOn) || opts.failOn;
        explicitFailOn = true;
        break;
      case 'help':
      case '--help':
        opts.help = true;
        break;
    }
  }
  return explicitFailOn;
}

function applyCommandDefaults(opts: CLIOptions, explicitFailOn: boolean): void {
  // inspect 默认仅报告（不阻断门禁）；guard/refactor/pipeline 默认 error 级门禁
  if (!explicitFailOn && opts.command === 'inspect') {
    opts.failOn = 'none';
  }
}

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

function writeReportFile(
  opts: CLIOptions,
  report: unknown,
  findings: Finding[],
  projectDir: string,
): void {
  if (opts.format === 'sarif') {
    const outPath = opts.report || 'zhshield.sarif';
    writeFileSync(path.resolve(projectDir, outPath), toSarif(findings), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  if (opts.format === 'json') {
    const outPath = opts.report || 'zhshield.json';
    writeFileSync(path.resolve(projectDir, outPath), formatReportJson(report), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  // text 或未知格式：不写机器可读文件
}

async function main(): Promise<void> {
  augmentProcessPath();
  const opts = parseArgs(process.argv);
  if (opts.help || opts.command === 'help') {
    printUsage();
    process.exit(0);
  }
  const reporter = new ConsoleReporter({ color: opts.color, verbose: opts.verbose });
  try {
    await runPipeline(opts, reporter);
  } catch (err: unknown) {
    handleError(reporter, err);
  }
}

/** 加载 SOP 规则并按命令分发执行 */
async function runPipeline(opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  const projectDir = resolveProjectDir(opts.dir);
  const sopDir = resolveBundledSopDir(baseDir);
  const runner = new PipelineRunner(projectDir, sopDir ? { configDir: sopDir } : undefined);
  const ruleCount = await runner.loadSopRules();
  console.error(`[CLI] 已加载 ${ruleCount} 条 SOP 规则\n`);
  if (opts.sop && ruleCount === 0) {
    console.error(
      '[CLI] ============================================================\n' +
        '[CLI] 降级警告: SOP 规则加载为 0 条 — 引擎处于盲检状态，所有检查将默认通过。\n' +
        '[CLI] 请检查规则目录（presets/sop-templates 下应包含 guard/inspect/security/sentinel/evolve 域目录）。\n' +
        '[CLI] ============================================================\n',
    );
    process.exitCode = 2;
  }

  switch (opts.command) {
    case 'guard':
      await runGuardCommand(runner, opts, reporter, projectDir);
      break;
    case 'inspect':
      await runInspectCommand(runner, opts, reporter, projectDir);
      break;
    case 'refactor':
      await runRefactorCommand(runner, opts, reporter, projectDir);
      break;
    case 'pipeline':
      await runPipelineCommand(runner, opts, reporter, projectDir);
      break;
    case 'baseline':
      await runBaselineCommand(runner, opts, reporter, projectDir);
      break;
    default:
      console.error(`未知命令: ${opts.command}`);
      printUsage();
      process.exit(1);
  }

  await runner.destroy();
}

/** 输出错误报告并退出 */
function handleError(reporter: ConsoleReporter, err: unknown): void {
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

async function runGuardCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopGuard({ dryRun: opts.dryRun });
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
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
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
  }
}

async function runInspectCommand(
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
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
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
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
  }
}

async function runRefactorCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  const report = await runner.runRefactor();
  const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
  const formatted = reporter.format({
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: report,
    passed: !blocked,
    stage: 'refactor',
  });
  console.log(formatted.text);
  writeReportFile(opts, report, findings, projectDir);
  process.exit(blocked ? 1 : process.exitCode);
}

async function runBaselineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  _reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  switch (opts.baselineAction) {
    case 'capture': {
      const report = await runner.runInspect({ skipBaseline: true });
      const entries = issuesToBaselineEntries(report.issues, projectDir);
      const saved = await saveBaseline(projectDir, entries);
      console.log(
        `基线已捕获: ${entries.length} 项问题 → ${baselinePath(projectDir)} (${saved.capturedAt})`,
      );
      process.exit(process.exitCode);
      break;
    }
    case 'list': {
      const baseline = await loadBaseline(projectDir);
      if (!baseline) {
        console.log('尚未捕获基线（无 .zhshield/baseline.json）');
        process.exit(0);
        break;
      }
      console.log(`基线 ${baseline.entries.length} 项，捕获于 ${baseline.capturedAt}`);
      for (const entry of baseline.entries) {
        console.log(`  ${entry.ruleId}  ${entry.file}:${entry.line}:${entry.column}`);
      }
      process.exit(process.exitCode);
      break;
    }
    case 'clear': {
      await clearBaseline(projectDir);
      console.log(`基线已清除: ${baselinePath(projectDir)}`);
      process.exit(process.exitCode);
      break;
    }
  }
  console.error('未知 baseline 子命令，支持: capture | list | clear');
  process.exit(1);
}

async function runPipelineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopDrivenPipeline();
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    const formatted = reporter.format(report);
    console.log(formatted.text);
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
  } else {
    const report = await runner.runFullPipeline({
      dryRun: opts.dryRun,
    });
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    const formatted = reporter.format(report);
    console.log(formatted.text);
    writeReportFile(opts, report, findings, projectDir);
    process.exit(blocked ? 1 : process.exitCode);
  }
}

main();
