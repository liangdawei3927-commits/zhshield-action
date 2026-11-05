import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SCAN_CHAIN_DOMAINS,
  type PipelineRunner,
  type DomainRunLedger,
  type DomainRunOptions,
} from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from '../cli-options';
import { runPipelineCommand, runFullScanCommand, runInspectCommand } from '../commands';

// --full（全量扫描链）语义：与桌面端/无头脚本共用同一批执行器与同一份账本；
// 门禁是纯判定域，不得进扫描链；任一域未完成以 exit 2 收尾，未检测 ≠ 通过。

// 本文件验证完整流水线命令的分发与降级聚合护栏：
// pipeline 是 CI 主入口，--sop 开关必须正确切换执行引擎；
// 降级判定要跨 guard/inspect 两个子报告聚合——任何一处盲检都不得伪装成通过。

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code ?? 0})`);
  }
}

function stubProcessExit(): void {
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitSignal(code == null ? undefined : Number(code));
  });
}

async function exitCodeOf(fn: () => Promise<void>): Promise<number | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
  throw new Error('命令未按契约调用 process.exit——门禁退出码语义丢失');
}

function makeOpts(overrides: Partial<CLIOptions>): CLIOptions {
  return {
    command: 'pipeline',
    dir: '',
    dryRun: false,
    sop: false,
    verbose: false,
    color: false,
    help: false,
    format: 'text',
    report: '',
    failOn: 'error',
    ...overrides,
  };
}

type MockRunner = Record<string, ReturnType<typeof vi.fn>>;
/**
 * 假 runner。`evaluatePostScanGates` 必须有默认实现：扫描类命令统一走
 * `finalizeScan`，--sop 时会调它；缺了抛 TypeError，而 TypeError 会被
 * 退出码哨兵吞掉，表现为"退出码对不上"，比直接缺方法难查得多。
 */
function makeRunner(methods: MockRunner): PipelineRunner {
  return {
    evaluatePostScanGates: vi.fn(() => ({
      total: 0,
      passed: 0,
      failed: 0,
      undetermined: 0,
      blockingFailed: 0,
      blockingUndetermined: 0,
      ok: true,
      complete: true,
      items: [],
    })),
    ...methods,
  } as unknown as PipelineRunner;
}
function makeReporter() {
  return { format: vi.fn(() => ({ text: 'PIPELINE-TEXT', passed: true })) };
}

/** 逐域账本最小形态：runFullScanCommand 只读 records / 耗时汇总 */
function makeLedger(records: DomainRunLedger['records']): DomainRunLedger {
  const sumMs = records.reduce((sum, record) => sum + record.durationMs, 0);
  return {
    repoRoot: '/proj',
    startedAt: new Date().toISOString(),
    sumMs,
    wallMs: sumMs,
    concurrency: 1,
    records,
  };
}

/** PipelineReport 最小形态：buildFindings 识别需 stage 字段 + guard/inspect/refactor 之一 */
function makePipelineReport(overrides: Record<string, unknown>) {
  return {
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: null,
    passed: true,
    stage: 'complete',
    ...overrides,
  };
}

describe('runPipelineCommand — 完整流水线命令', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('Given 默认模式，When pipeline，Then 调用 runFullPipeline 并透传 dry-run，exit 0（无违规）', async () => {
    const report = makePipelineReport({});
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => report),
      runSopDrivenPipeline: vi.fn(async () => report),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({ dryRun: true }), {
        reporter: reporter as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(code).toBeUndefined();
    expect(runner.runFullPipeline).toHaveBeenCalledWith({ dryRun: true });
    expect(runner.runSopDrivenPipeline).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('PIPELINE-TEXT');
  });

  it('Given --sop，When pipeline，Then 切换为 SOP 驱动引擎——两套引擎混用会让报告语义不可信', async () => {
    const report = makePipelineReport({});
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => report),
      runSopDrivenPipeline: vi.fn(async () => report),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({ sop: true }), {
        reporter: reporter as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(code).toBeUndefined();
    expect(runner.runSopDrivenPipeline).toHaveBeenCalledTimes(1);
    expect(runner.runFullPipeline).not.toHaveBeenCalled();
  });

  it('Given 流水线含 error 级发现（guard 阶段违规），When pipeline，Then exit 1', async () => {
    const report = makePipelineReport({
      guard: {
        ok: false,
        mode: 'guard',
        target: '/proj',
        timestamp: new Date(),
        summary: { total: 1, passed: 0, failed: 1 },
        results: [
          { checkId: 'guard.chk.x', status: 'failed', severity: 'error', message: '存在错误' },
        ],
      },
    });
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => report),
      runSopDrivenPipeline: vi.fn(async () => report),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({}), {
        reporter: reporter as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(code).toBe(1);
  });

  it('Given guard 空跑盲检 + inspect 含 1 个降级适配器，When pipeline，Then 聚合为 2 项降级并以 exit 2 拦停——子报告必须逐个累计，漏一处即漏一次盲检', async () => {
    const report = makePipelineReport({
      guard: {
        ok: true,
        mode: 'guard',
        target: '/proj',
        timestamp: new Date(),
        summary: { total: 0, passed: 0, failed: 0 },
        results: [], // 零结果空跑 = 盲检，计 1
      },
      inspect: {
        projectId: 'p',
        timestamp: new Date(),
        scanType: 'full',
        duration: 1,
        score: { overall: 100, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'semgrep',
            adapterName: 'semgrep',
            duration: 0,
            issueCount: 0,
            passed: false,
            degraded: true,
            status: 'skipped',
            skipReason: 'degraded',
            issues: [],
          },
        ],
        recommendations: [],
      },
    });
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => report),
      runSopDrivenPipeline: vi.fn(async () => report),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({ failOn: 'none' }), {
        reporter: reporter as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('2 项检查未实际执行');
    expect(errors.join('\n')).toContain('未检测 ≠ 通过');
  });

  it('Given --full，When pipeline，Then 走全量扫描链而非两段式引擎（同一批执行器）', async () => {
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => makePipelineReport({})),
      runSopDrivenPipeline: vi.fn(async () => makePipelineReport({})),
    });
    const reporter = makeReporter();
    const seen: DomainRunOptions[] = [];

    await runPipelineCommand(runner, makeOpts({ full: true }), {
      reporter: reporter as unknown as ConsoleReporter,
      projectDir: '/proj',
      fullScanDeps: {
        runDomains: async (options) => {
          seen.push(options);
          return makeLedger([{ domain: 'inspect', status: 'ok', durationMs: 800 }]);
        },
      },
    });

    expect(runner.runFullPipeline).not.toHaveBeenCalled();
    expect(runner.runSopDrivenPipeline).not.toHaveBeenCalled();
    // --full 不产出 PipelineReport，reporter 不该被调用（避免两套 schema 混用）
    expect(reporter.format).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('全量扫描完成');

    // A6/A12：门禁是纯判定域，不进扫描链（无域快照时会退回工具派发，同一工具跑第二次）
    expect(seen[0].domains).not.toContain('guard');
    expect(seen[0].domains).toEqual([...SCAN_CHAIN_DOMAINS]);
    // A15：CLI 必须注入真实 CVE 查询，否则依赖域永远只能报「未检测」
    expect(seen[0].depsScanInput?.cveProvider).toBeTypeOf('function');
  });

  it('Given --domains 子集，When 全量扫描，Then 只跑该子集（C5 单域入口）', async () => {
    const runner = makeRunner({});
    const seen: DomainRunOptions[] = [];

    await runFullScanCommand(
      runner,
      makeOpts({ full: true, domains: ' deps , security ,deps' }),
      '/proj',
      {
        runDomains: async (options) => {
          seen.push(options);
          return makeLedger([{ domain: 'deps', status: 'ok', durationMs: 100 }]);
        },
      },
    );

    // 去重 + 去空白，顺序保持用户书写顺序
    expect(seen[0].domains).toEqual(['deps', 'security']);
  });

  it('Given --domains 含未知域名，When 全量扫描，Then 报错 exit 1 且不跑任何域（不静默忽略）', async () => {
    const runner = makeRunner({});
    const runDomainsSpy = vi.fn();

    await runFullScanCommand(runner, makeOpts({ full: true, domains: 'deps,depz' }), '/proj', {
      runDomains: runDomainsSpy,
    });

    expect(runDomainsSpy).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('未知域名: depz');
    expect(process.exitCode).toBe(1);
  });

  it('Given --domains 但无 --full/--sop，When pipeline，Then 报错 exit 1（避免用户以为跑了子集）', async () => {
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => makePipelineReport({})),
      runSopDrivenPipeline: vi.fn(async () => makePipelineReport({})),
    });

    await runPipelineCommand(runner, makeOpts({ domains: 'deps' }), {
      reporter: makeReporter() as unknown as ConsoleReporter,
      projectDir: '/proj',
    });

    expect(runner.runFullPipeline).not.toHaveBeenCalled();
    expect(runner.runSopDrivenPipeline).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--domains 只与 --full');
    expect(process.exitCode).toBe(1);
  });

  it('Given --full 且存在未完成域，When 全量扫描，Then 逐域打印并以 exit 2 收尾（未检测 ≠ 通过）', async () => {
    const runner = makeRunner({});

    await runFullScanCommand(runner, makeOpts({ full: true }), '/proj', {
      runDomains: async () =>
        makeLedger([
          { domain: 'inspect', status: 'ok', durationMs: 800 },
          {
            domain: 'deps',
            status: 'partial',
            durationMs: 434,
            reason: '依赖 CVE 未检测（漏洞库不可达）',
          },
        ]),
    });

    expect(logs.join('\n')).toContain('inspect ok 0.80s');
    expect(logs.join('\n')).toContain('deps partial 0.43s — 依赖 CVE 未检测（漏洞库不可达）');
    expect(logs.join('\n')).toContain('sumMs=1234');
    expect(errors.join('\n')).toContain('1 个域未完成：deps(partial)');
    expect(errors.join('\n')).toContain('未检测 ≠ 通过');
    expect(process.exitCode).toBe(2);
  });

  it('Given 各域完成或 not-run（techdebt 需宿主注入），When 全量扫描，Then 不置 exitCode——not-run 不等于失败', async () => {
    const runner = makeRunner({});

    await runFullScanCommand(runner, makeOpts({ full: true }), '/proj', {
      runDomains: async () =>
        makeLedger([
          { domain: 'inspect', status: 'ok', durationMs: 800 },
          {
            domain: 'techdebt',
            status: 'not-run',
            durationMs: 0,
            reason: '需调用方注入执行器',
          },
        ]),
    });

    expect(process.exitCode).toBeUndefined();
    expect(errors.join('\n')).not.toContain('未检测 ≠ 通过');
    // 未跑的域仍要如实打印，不能静默当作通过（C4/C5）
    expect(logs.join('\n')).toContain('techdebt not-run 0.00s — 需调用方注入执行器');
  });

  it('Given 同时存在阻断级违规与降级，When pipeline，Then exit 1——硬门禁失败优先于降级提醒', async () => {
    const report = makePipelineReport({
      guard: {
        ok: false,
        mode: 'guard',
        target: '/proj',
        timestamp: new Date(),
        summary: { total: 1, passed: 0, failed: 1 },
        results: [
          { checkId: 'guard.chk.x', status: 'failed', severity: 'error', message: '存在错误' },
        ],
      },
      inspect: {
        projectId: 'p',
        timestamp: new Date(),
        scanType: 'full',
        duration: 1,
        score: { overall: 100, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'semgrep',
            adapterName: 'semgrep',
            duration: 0,
            issueCount: 0,
            passed: false,
            degraded: true,
            status: 'skipped',
            skipReason: 'degraded',
            issues: [],
          },
        ],
        recommendations: [],
      },
    });
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => report),
      runSopDrivenPipeline: vi.fn(async () => report),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({}), {
        reporter: reporter as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(code).toBe(1);
  });
});

// `--sop` 是历史单体路径（三域合并、无域预算、无硬超时，实测 85 条规则下 4 分 22 秒未结束）。
// `--domains` 是它的收敛手段：按域收窄到 SOP 真正会求值的域。这里锁两件事：
//   ① 指定域必须真的传进引擎（否则等于没收敛）
//   ② SOP 不求值的域必须报错，不能"跑了 0 条规则却显示通过"
describe('--domains × --sop（SOP 链路按域收敛，不静默空跑）', () => {
  let errors: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  it('Given inspect --sop --domains security，Then 只把该域交给 SOP 引擎', async () => {
    // 用哨兵异常截断：断言只关心"传了什么给引擎"，不必伪造一整份 RuleEngineReport
    const sentinel = new Error('stop-after-dispatch');
    const runSopInspect = vi.fn(async () => {
      throw sentinel;
    });
    const runner = makeRunner({ runSopInspect });

    await expect(
      runInspectCommand(
        runner,
        makeOpts({ command: 'inspect', sop: true, domains: 'security' }),
        makeReporter() as unknown as ConsoleReporter,
        '/proj',
      ),
    ).rejects.toBe(sentinel);

    expect(runSopInspect).toHaveBeenCalledWith({ domains: ['security'] });
  });

  it('Given inspect --sop --domains deps，Then 报错 exit 1 且不调用引擎（deps 不在 SOP 求值范围）', async () => {
    const runSopInspect = vi.fn();
    const runner = makeRunner({ runSopInspect });

    await runInspectCommand(
      runner,
      makeOpts({ command: 'inspect', sop: true, domains: 'deps' }),
      makeReporter() as unknown as ConsoleReporter,
      '/proj',
    );

    expect(runSopInspect).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('deps');
    expect(process.exitCode).toBe(1);
  });

  it('Given pipeline --sop --domains inspect,security，Then 注入 inspectContext.domains', async () => {
    const runner = makeRunner({
      runFullPipeline: vi.fn(async () => makePipelineReport({})),
      runSopDrivenPipeline: vi.fn(async () => makePipelineReport({})),
    });

    // 命令以 process.exit 收尾，必须经 exitCodeOf 捕获（本组已 stub process.exit）
    await exitCodeOf(() =>
      runPipelineCommand(runner, makeOpts({ sop: true, domains: 'inspect,security' }), {
        reporter: makeReporter() as unknown as ConsoleReporter,
        projectDir: '/proj',
      }),
    );

    expect(runner.runSopDrivenPipeline).toHaveBeenCalledWith({
      inspectContext: { domains: ['inspect', 'security'] },
    });
    expect(runner.runFullPipeline).not.toHaveBeenCalled();
  });

  it('Given inspect（无 --sop）带 --domains，Then 报错 exit 1（checks.json 链路没有域概念）', async () => {
    const runner = makeRunner({ runInspect: vi.fn() });

    await runInspectCommand(
      runner,
      makeOpts({ command: 'inspect', domains: 'inspect' }),
      makeReporter() as unknown as ConsoleReporter,
      '/proj',
    );

    expect(runner.runInspect).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--domains 只与 --full');
    expect(process.exitCode).toBe(1);
  });
});
