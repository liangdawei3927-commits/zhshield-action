import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PipelineRunner } from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from '../cli-options';
import { runGuardCommand } from '../commands';

// ─── 测试辅助 ──────────────────────────────────────────

/**
 * process.exit 哨兵：命令层以 process.exit(code) 表达门禁结果并终止进程。
 * 测试中把 exit 替换为抛出本错误，使命令在退出点停下、退出码可被断言。
 * 退出码是 CI 消费的核心契约（0 通过 / 1 阻断 / 2 降级），必须严格守住。
 */
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

/** 驱动一个会以 process.exit 终止的命令，归还其退出码（undefined 视为 0） */
async function exitCodeOf(fn: () => Promise<void>): Promise<number | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
  throw new Error('命令未按契约调用 process.exit——门禁退出码语义丢失');
}

/** 构造命令选项（默认值与 index.ts createDefaultOptions 保持一致） */
function makeOpts(overrides: Partial<CLIOptions>): CLIOptions {
  return {
    command: 'guard',
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
  return {
    format: vi.fn((): { text: string; passed: boolean } => ({ text: 'TEXT-REPORT', passed: true })),
    formatRuleEngine: vi.fn(
      (): { text: string; passed: boolean } => ({ text: 'RULE-REPORT', passed: false }),
    ),
  };
}

/** GuardReport 最小形态：buildFindings 识别该形态只需 results 数组 + summary */
function makeGuardReport(results: unknown[], summary = { total: 1, passed: 0, failed: 1 }) {
  return {
    ok: summary.failed > 0,
    mode: 'guard',
    target: '/proj',
    timestamp: new Date(),
    results,
    summary,
  };
}

/** RuleEngineReport 最小形态（SOP 分支产出） */
function makeRuleEngineReport(evaluations: unknown[], counts?: { degraded?: number; ok?: boolean }) {
  return {
    total: evaluations.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: evaluations.length,
    ok: counts?.ok ?? true,
    degraded: counts?.degraded,
    evaluations,
    durationMs: 5,
    timestamp: new Date(),
  };
}

function skippedDegradedEval(id: string, message: string) {
  return {
    rule: { id, name: id },
    status: 'skipped',
    degraded: true,
    message,
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

describe('runGuardCommand — Guard 门禁命令（退出码即门禁契约）', () => {
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

  it('Given error 级违规且 failOn=error（默认阈值）、非 dry-run，When guard，Then exit 1——CI 必须因门禁失败而变红', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([
        { checkId: 'guard.chk.eslint', status: 'failed', severity: 'error', message: '存在 ESLint 错误' },
      ])),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({}), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(1);
    // 默认（无 --sop）走 checks.json 模式，不得误入 SOP 引擎分支
    expect(runner.runGuard).toHaveBeenCalledTimes(1);
    expect(runner.runSopGuard).not.toHaveBeenCalled();
    // 文本报告必须已输出到 stdout，供本地开发者阅读
    expect(logs.join('\n')).toContain('TEXT-REPORT');
  });

  it('Given 相同违规但 --dry-run，When guard，Then 不阻断（exit 0）——dry-run 只报告不拦截是用户显式选择', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([
        { checkId: 'guard.chk.eslint', status: 'failed', severity: 'error', message: '存在 ESLint 错误' },
      ])),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({ dryRun: true }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined(); // process.exit(process.exitCode=undefined) ≡ 0
  });

  it('Given warning 级违规且 failOn=error，When guard，Then 不阻断——默认阈值不得因 warning 拦停流水线', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([
        { checkId: 'guard.chk.style', status: 'failed', severity: 'warning', message: '命名不规范' },
      ])),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({}), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined();
  });

  it('Given error 级违规但 failOn=none，When guard，Then 不阻断——fail-on none 表示用户显式关闭阻断', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([
        { checkId: 'guard.chk.eslint', status: 'failed', severity: 'error', message: '存在 ESLint 错误' },
      ])),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({ failOn: 'none' }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined();
  });

  it('Given 全部检查通过，When guard，Then exit 0——通过时不得误报失败', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () =>
        makeGuardReport(
          [{ checkId: 'guard.chk.ok', status: 'passed', severity: 'error', message: '通过' }],
          { total: 1, passed: 1, failed: 0 },
        ),
      ),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({}), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined();
    expect(errors.join('\n')).not.toContain('降级警告');
  });

  it('Given --sop 且 SOP 规则失败（含违规），When guard，Then 走 SOP 分支并以 exit 1 阻断', async () => {
    const sopReport = makeRuleEngineReport(
      [
        {
          rule: { id: 'guard.block.sensitive-info', name: '敏感信息检测' },
          status: 'failed',
          message: '发现 1 处匹配',
          violations: [
            {
              id: 'v1',
              ruleId: 'guard.block.sensitive-info',
              severity: 'critical',
              file: 'src/config.ts',
              line: 5,
              message: '匹配到 API Key',
            },
          ],
          targetEngine: 'guard',
          timestamp: new Date(),
        },
      ],
      { ok: false },
    );
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([])),
      runSopGuard: vi.fn(async () => sopReport),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({ sop: true }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(1);
    expect(runner.runSopGuard).toHaveBeenCalledWith({ dryRun: false });
    expect(runner.runGuard).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('RULE-REPORT');
  });

  it('Given --sop 且报告 degraded>0（规则被降级跳过），When guard，Then exit 2——"未检测 ≠ 通过"，盲检不得静默放行', async () => {
    const sopReport = makeRuleEngineReport(
      [skippedDegradedEval('guard.chk.tsc', 'tsc 不可用')],
      { degraded: 1, ok: true },
    );
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([])),
      runSopGuard: vi.fn(async () => sopReport),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(runner, makeOpts({ sop: true }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('降级警告');
    expect(errors.join('\n')).toContain('未检测 ≠ 通过');
  });
});
