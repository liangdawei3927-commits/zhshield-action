#!/usr/bin/env tsx
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
      case 'help':
      case '--help':
        opts.help = true;
        break;
    }
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.help || opts.command === 'help') {
    printUsage();
    process.exit(0);
  }

  const reporter = new ConsoleReporter({ color: opts.color, verbose: opts.verbose });

  try {
    const runner = new PipelineRunner(opts.dir);
    const ruleCount = await runner.loadSopRules();
    console.error(`[CLI] 已加载 ${ruleCount} 条 SOP 规则\n`);

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
    process.exit(formatted.passed ? 0 : 1);
  } else {
    const report = await runner.runGuard({ dryRun: opts.dryRun });
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: report,
      inspect: null,
      refactor: null,
      passed: report.ok !== false,
      stage: 'guard',
    });
    console.log(formatted.text);
    process.exit(formatted.passed ? 0 : 1);
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
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: report,
      refactor: null,
      passed: true,
      stage: 'inspect',
    });
    console.log(formatted.text);
    process.exit(0);
  }
}

async function runRefactorCommand(runner: PipelineRunner, reporter: ConsoleReporter): Promise<void> {
  const report = await runner.runRefactor();
  const formatted = reporter.format({
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: report,
    passed: true,
    stage: 'refactor',
  });
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

main();
