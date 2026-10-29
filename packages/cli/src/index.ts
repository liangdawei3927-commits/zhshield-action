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
import { currentSopCacheEnv, readCacheFreshness, resolveSopCacheDir } from './sop-source';
import type { SopCacheResolution } from './sop-source';
import { formatSopSourceBanner, setSopSourceSummary } from './sop-banner';
import type { SopSourceSummary } from './sop-banner';
import { ConsoleReporter, FAIL_ON_VALUES, isFailOnValue } from '@zh/reporter';
import { augmentProcessPath } from '@zh/shared';
import * as path from 'node:path';
import type { CLIOptions } from './cli-options';
// 命令实现层（guard/inspect/refactor/pipeline/baseline）与报告落盘已抽出至同目录 commands.ts
import {
  handleError,
  runGuardCommand,
  runInspectCommand,
  runRefactorCommand,
  runPipelineCommand,
  runBaselineCommand,
} from './commands';

// 双模兼容：bundle 为 CJS（esbuild format:'cjs'），__dirname 原生可用；
// 开发态（tsx 以 ESM 运行）__dirname 未声明，typeof 安全返回 undefined，
// 改为从被执行脚本路径（process.argv[1]）推导，避免 import.meta（tsc CommonJS 不支持）。
function resolveBaseDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  const invoked = process.argv[1];
  // 经复核的非注入点：argv[1] 是 Node 已解析并执行的脚本自身路径（能改写它者已具代码执行
  // 能力），且这里没有「被限制在某个 base 内」的语义；改用 safeResolve(base, ...) 必须人为
  // 假定一个 base，反而会破坏 bundle / 开发态双模。故在此定点抑制（见下一行注释）。
  if (invoked) return path.dirname(path.resolve(invoked)); // nosemgrep: detect-path-traversal
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
  zhshield baseline capture-refactor [--dir <path>]  捕获重构存量异味为棘轮基线（此后只报增量）
  zhshield baseline clear-refactor [--dir <path>]    清除重构棘轮基线
  zhshield help                显示此帮助

选项:
  --dir <path>    项目根目录（默认: 当前目录）
  --dry-run       Guard 模式：只报告不阻断
  --sop           使用 SOP 规则驱动模式（默认: checks.json 模式）
  --verbose       显示详细信息
  --no-color      禁用颜色输出
  --format <fmt>  报告格式: text(默认) | json | sarif
  --report <path> 机器可读报告输出路径 (json/sarif 时生效)
  --fail-on <lvl> 阻断阈值: guard/refactor/pipeline 默认 error | inspect 默认 none(仅报告) | warning | info | 合法值: error | warning | info | none
`);
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

/** 布尔型开关（不消费后一个参数）：命中返回 true，未知参数返回 false 交由调用方处理 */
function applyBooleanFlag(arg: string, opts: CLIOptions): boolean {
  switch (arg) {
    case '--dry-run':
      opts.dryRun = true;
      return true;
    case '--sop':
      opts.sop = true;
      return true;
    case '--verbose':
      opts.verbose = true;
      return true;
    case '--no-color':
      opts.color = false;
      return true;
    case 'help':
    case '--help':
      opts.help = true;
      return true;
    default:
      return false;
  }
}

function parseFlags(args: string[], opts: CLIOptions): boolean {
  let explicitFailOn = false;
  for (let i = 1; i < args.length; i++) {
    if (applyBooleanFlag(args[i], opts)) continue;
    switch (args[i]) {
      case '--dir':
        opts.dir = args[++i] || opts.dir;
        break;
      case '--format':
        opts.format = (args[++i] as CLIOptions['format']) || opts.format;
        break;
      case '--report':
        opts.report = args[++i] || opts.report;
        break;
      case '--fail-on': {
        // 解析边界校验：非法值（含缺参/空串）直接报错退出，禁止静默降级为默认阈值
        const raw = args[++i];
        if (!isFailOnValue(raw)) {
          console.error(
            `[CLI] 非法 --fail-on 值: ${raw ?? '(空)'}，合法值: ${FAIL_ON_VALUES.join(' | ')}`,
          );
          process.exit(2);
        }
        opts.failOn = raw;
        explicitFailOn = true;
        break;
      }
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

/** 加载 SOP 规则（内置 + 云端同步）并按命令分发执行 */
async function runPipeline(opts: CLIOptions, reporter: ConsoleReporter): Promise<void> {
  const projectDir = resolveProjectDir(opts.dir);
  const sopDir = resolveBundledSopDir(baseDir);
  const runner = new PipelineRunner(projectDir, sopDir ? { configDir: sopDir } : undefined);
  const summary = await loadSopRulesWithCloud(runner);
  for (const line of formatSopSourceBanner(summary)) console.error(line);
  // 必须在分发**之前**注入：命令实现以 process.exit() 终止进程，switch 之后的所有代码
  // 在真实进程里都不可达（本轮实测踩到，见 sop-banner.ts 头注释的形态⑧）。
  setSopSourceSummary(summary);

  if (opts.sop && summary.total === 0) {
    console.error(
      '[CLI] ============================================================\n' +
        '[CLI] 降级警告: SOP 规则注册为 0 条 — 引擎处于盲检状态，所有检查将默认通过。\n' +
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

  // 命令若正常返回（未 exit），此处收尾；命令已 exit 时下面两行不会执行
  await runner.destroy();
}

/**
 * 装载规则：内置模板 + 云端同步缓存。
 *
 * 与桌面端 `pipeline-runner-factory.createLoadedRunner` 同口径 —— 只载内置 43 条
 * 等于把「桌面端口径 vs CLI 口径」劈成两套：云端那 52 条（含全部阻断型门禁规则）
 * 在 CLI 侧整段缺席，pre-commit 的绿灯就是一次没发生的判定。
 */
async function loadSopRulesWithCloud(runner: PipelineRunner): Promise<SopSourceSummary> {
  const cache: SopCacheResolution = resolveSopCacheDir(currentSopCacheEnv());
  const bundled = await runner.loadSopRules();
  const synced = cache.dir ? await runner.loadSopRulesFromCache(cache.dir) : 0;
  const stats = runner.getSopStats();
  return {
    bundled,
    synced,
    total: stats.total,
    active: stats.active,
    cache,
    freshness: cache.dir ? readCacheFreshness(cache.dir) : { fileCount: 0 },
  };
}

main();
