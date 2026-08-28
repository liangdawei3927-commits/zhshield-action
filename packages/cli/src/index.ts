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
import { augmentProcessPath } from '@zh/shared';
import * as path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

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

/** 随 bundle 打包的 SOP 规则目录（build-cli.mjs 复制到 dist/sop）。
 *  不存在时回退到 @zh/pipeline 的 monorepo 默认路径，保证开发态不受影响。 */
function resolveBundledSopDir(): string | undefined {
  const bundled = path.join(baseDir, 'sop');
  return existsSync(bundled) ? bundled : undefined;
}

function printUsage(): void {
  console.log(`
zhshield — 智汇码盾 代码质量治理

用法:
  zhshield guard [options]     执行 Guard 门禁检查
  zhshield inspect [options]   执行 Inspect 巡检
  zhshield refactor [options]  执行 Refactor 重构检测
  zhshield pipeline [options]  执行完整流水线
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
}

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    command: '',
    dir: process.cwd(),
    dryRun: false,
    sop: false,
    verbose: false,
    color: true,
    help: false,
    format: 'text',
    report: '',
    failOn: 'error',
  };

  const args = argv.slice(2);
  if (args.length === 0) {
    opts.help = true;
    return opts;
  }

  let explicitFailOn = false;

  opts.command = args[0];
  if (opts.command === 'help') {
    opts.help = true;
  }

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

  // inspect 默认仅报告（不阻断门禁）；guard/refactor/pipeline 默认 error 级门禁
  if (!explicitFailOn && opts.command === 'inspect') {
    opts.failOn = 'none';
  }

  return opts;
}

function shouldBlock(report: unknown, failOn: FailOn, dryRun: boolean): { findings: Finding[]; blocked: boolean } {
  const findings = buildFindings(report);
  const blocked = !dryRun && failOn !== 'none' &&
    findings.some((f) => severityRank(f.severity) >= failOnRank(failOn));
  return { findings, blocked };
}

function writeReportFile(opts: CLIOptions, report: unknown, findings: Finding[]): void {
  if (opts.format === 'sarif') {
    const outPath = opts.report || 'zhshield.sarif';
    writeFileSync(path.resolve(process.cwd(), outPath), toSarif(findings), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  if (opts.format === 'json') {
    const outPath = opts.report || 'zhshield.json';
    writeFileSync(path.resolve(process.cwd(), outPath), formatReportJson(report), 'utf8');
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
    const sopDir = resolveBundledSopDir();
    const runner = new PipelineRunner(opts.dir, sopDir ? { configDir: sopDir } : undefined);
    const ruleCount = await runner.loadSopRules();
    console.error(`[CLI] 已加载 ${ruleCount} 条 SOP 规则\n`);

    switch (opts.command) {
      case 'guard': await runGuardCommand(runner, opts, reporter); break;
      case 'inspect': await runInspectCommand(runner, opts, reporter); break;
      case 'refactor': await runRefactorCommand(runner, opts, reporter); break;
      case 'pipeline': await runPipelineCommand(runner, opts, reporter); break;
      default:
        console.error(`未知命令: ${opts.command}`);
        printUsage();
        process.exit(1);
    }

    await runner.destroy();
  } catch (err: unknown) {
    console.error(reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: null,
      refactor: null,
      passed: false,
      stage: 'complete',
      error: err instanceof Error ? err.message : String(err),
    }).text);
    process.exit(1);
  }
}

async function runGuardCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopGuard({ dryRun: opts.dryRun });
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  } else {
    const report = await runner.runGuard({ dryRun: opts.dryRun });
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: report,
      inspect: null,
      refactor: null,
      passed: !blocked,
      stage: 'guard',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  }
}

async function runInspectCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopInspect();
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, false);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  } else {
    const report = await runner.runInspect();
    const { findings, blocked } = shouldBlock(report, opts.failOn, false);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: report,
      refactor: null,
      passed: !blocked,
      stage: 'inspect',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  }
}

async function runRefactorCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  const report = await runner.runRefactor();
  const { findings, blocked } = shouldBlock(report, opts.failOn, false);
  const formatted = reporter.format({
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: report,
    passed: !blocked,
    stage: 'refactor',
  });
  console.log(formatted.text);
  writeReportFile(opts, report, findings);
  process.exit(blocked ? 1 : 0);
}

async function runPipelineCommand(runner: PipelineRunner, opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopDrivenPipeline();
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun);
    const formatted = reporter.format(report);
    console.log(formatted.text);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  } else {
    const report = await runner.runFullPipeline({
      dryRun: opts.dryRun,
    });
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun);
    const formatted = reporter.format(report);
    console.log(formatted.text);
    writeReportFile(opts, report, findings);
    process.exit(blocked ? 1 : 0);
  }
}

main();
