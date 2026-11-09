import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    formatRuleEngine: vi.fn((): { text: string; passed: boolean } => ({
      text: 'RULE-REPORT',
      passed: false,
    })),
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
function makeRuleEngineReport(
  evaluations: unknown[],
  counts?: { degraded?: number; ok?: boolean },
) {
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
      runGuard: vi.fn(async () =>
        makeGuardReport([
          {
            checkId: 'guard.chk.eslint',
            status: 'failed',
            severity: 'error',
            message: '存在 ESLint 错误',
          },
        ]),
      ),
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
      runGuard: vi.fn(async () =>
        makeGuardReport([
          {
            checkId: 'guard.chk.eslint',
            status: 'failed',
            severity: 'error',
            message: '存在 ESLint 错误',
          },
        ]),
      ),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(
        runner,
        makeOpts({ dryRun: true }),
        reporter as unknown as ConsoleReporter,
        '/proj',
      ),
    );

    expect(code).toBeUndefined(); // process.exit(process.exitCode=undefined) ≡ 0
  });

  it('Given warning 级违规且 failOn=error，When guard，Then 不阻断——默认阈值不得因 warning 拦停流水线', async () => {
    const runner = makeRunner({
      runGuard: vi.fn(async () =>
        makeGuardReport([
          {
            checkId: 'guard.chk.style',
            status: 'failed',
            severity: 'warning',
            message: '命名不规范',
          },
        ]),
      ),
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
      runGuard: vi.fn(async () =>
        makeGuardReport([
          {
            checkId: 'guard.chk.eslint',
            status: 'failed',
            severity: 'error',
            message: '存在 ESLint 错误',
          },
        ]),
      ),
      runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(
        runner,
        makeOpts({ failOn: 'none' }),
        reporter as unknown as ConsoleReporter,
        '/proj',
      ),
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
      runGuardCommand(
        runner,
        makeOpts({ sop: true }),
        reporter as unknown as ConsoleReporter,
        '/proj',
      ),
    );

    expect(code).toBe(1);
    expect(runner.runSopGuard).toHaveBeenCalledWith({ dryRun: false });
    expect(runner.runGuard).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('RULE-REPORT');
  });

  it('Given --sop 且报告 degraded>0（规则被降级跳过），When guard，Then exit 2——"未检测 ≠ 通过"，盲检不得静默放行', async () => {
    const sopReport = makeRuleEngineReport([skippedDegradedEval('guard.chk.tsc', 'tsc 不可用')], {
      degraded: 1,
      ok: true,
    });
    const runner = makeRunner({
      runGuard: vi.fn(async () => makeGuardReport([])),
      runSopGuard: vi.fn(async () => sopReport),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runGuardCommand(
        runner,
        makeOpts({ sop: true }),
        reporter as unknown as ConsoleReporter,
        '/proj',
      ),
    );

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('降级警告');
    expect(errors.join('\n')).toContain('未检测 ≠ 通过');
  });

  it('Given 供应商域快照已落盘，When guard --sop，Then 注入只读结论集（A6），不再回退工具派发', async () => {
    const project = await mkdtemp(join(tmpdir(), 'zhshield-cli-guard-'));
    try {
      const domainsDir = join(project, '.zhshield', 'diagnostics', 'domains');
      await mkdir(domainsDir, { recursive: true });
      await writeFile(
        join(domainsDir, 'inspect.json'),
        JSON.stringify({
          version: '1.0',
          project: { path: project, name: 'demo' },
          generatedAt: '2026-11-01T00:00:00.000Z',
          summary: { total: 1, error: 1, warning: 0, info: 0 },
          issues: [
            {
              ruleId: 'inspect.official.no-any',
              severity: 'error',
              category: 'type',
              message: 'any 滥用',
              file: 'src/a.ts',
              autoFixable: false,
              fingerprint: 'fp-a',
              source: 'inspect',
            },
          ],
          files: [],
        }),
        'utf-8',
      );

      const runner = makeRunner({
        runGuard: vi.fn(async () => makeGuardReport([])),
        // 断言注入内容前先接住实参，门禁只读判定的输入契约就锁在这里
        runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
      });
      const reporter = makeReporter();

      await exitCodeOf(() =>
        runGuardCommand(
          runner,
          makeOpts({ sop: true }),
          reporter as unknown as ConsoleReporter,
          project,
        ),
      );

      expect(runner.runSopGuard).toHaveBeenCalledWith({
        dryRun: false,
        conclusions: {
          inspect: expect.objectContaining({ domain: 'inspect', issues: expect.any(Array) }),
        },
      });
      expect(errors.join('\n')).not.toContain('退回工具派发');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  describe('--hook 钩子判定（纯判定 + 缺证据不静默放行）', () => {
    const HOOK_ENV = 'ZH_GATE_REQUIRE_SOP';
    let prevEnv: string | undefined;

    beforeEach(() => {
      prevEnv = process.env[HOOK_ENV];
      delete process.env[HOOK_ENV];
    });

    afterEach(() => {
      if (prevEnv === undefined) delete process.env[HOOK_ENV];
      else process.env[HOOK_ENV] = prevEnv;
    });

    /** 落盘一份最小 inspect 域快照：门禁据此认定「有结论可判」 */
    async function withInspectSnapshot(): Promise<{
      project: string;
      cleanup: () => Promise<void>;
    }> {
      const project = await mkdtemp(join(tmpdir(), 'zhshield-cli-hook-'));
      const domainsDir = join(project, '.zhshield', 'diagnostics', 'domains');
      await mkdir(domainsDir, { recursive: true });
      await writeFile(
        join(domainsDir, 'inspect.json'),
        JSON.stringify({
          version: '1.0',
          project: { path: project, name: 'demo' },
          generatedAt: '2026-11-01T00:00:00.000Z',
          summary: { total: 0, error: 0, warning: 0, info: 0 },
          issues: [],
          files: [],
        }),
        'utf-8',
      );
      return { project, cleanup: () => rm(project, { recursive: true, force: true }) };
    }

    it('Given 无供应商域快照，When guard --hook=pre-commit，Then 明确告知「未判定」并宽松放行（exit 0）', async () => {
      const project = await mkdtemp(join(tmpdir(), 'zhshield-cli-hook-empty-'));
      try {
        const runner = makeRunner({
          runGuard: vi.fn(async () => makeGuardReport([])),
          runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
        });
        const reporter = makeReporter();

        const code = await exitCodeOf(() =>
          runGuardCommand(
            runner,
            makeOpts({ hook: 'pre-commit' }),
            reporter as unknown as ConsoleReporter,
            project,
          ),
        );

        expect(code).toBeUndefined();
        expect(runner.runSopGuard).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('无法判定');
        expect(errors.join('\n')).toContain('未经门禁实际判定');
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    });

    it('Given 无快照且 ZH_GATE_REQUIRE_SOP=1，When guard --hook=pre-push，Then exit 2——缺证据不得按通过', async () => {
      process.env[HOOK_ENV] = '1';
      const project = await mkdtemp(join(tmpdir(), 'zhshield-cli-hook-strict-'));
      try {
        const runner = makeRunner({
          runGuard: vi.fn(async () => makeGuardReport([])),
          runSopGuard: vi.fn(async () => makeRuleEngineReport([])),
        });
        const reporter = makeReporter();

        const code = await exitCodeOf(() =>
          runGuardCommand(
            runner,
            makeOpts({ hook: 'pre-push' }),
            reporter as unknown as ConsoleReporter,
            project,
          ),
        );

        expect(code).toBe(2);
        expect(errors.join('\n')).toContain('ZH_GATE_REQUIRE_SOP');
      } finally {
        await rm(project, { recursive: true, force: true });
        delete process.env[HOOK_ENV];
      }
    });

    it('Given 快照存在且规则失败，When guard --hook=pre-commit，Then 注入结论集、exit 1，且不跑后置门禁', async () => {
      const { project, cleanup } = await withInspectSnapshot();
      try {
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
          runGuardCommand(
            runner,
            makeOpts({ hook: 'pre-commit' }),
            reporter as unknown as ConsoleReporter,
            project,
          ),
        );

        expect(code).toBe(1);
        expect(runner.runGuard).not.toHaveBeenCalled();
        expect(runner.runSopGuard).toHaveBeenCalledWith({
          dryRun: false,
          conclusions: {
            inspect: expect.objectContaining({ domain: 'inspect', issues: expect.any(Array) }),
          },
        });
        // 健康分/覆盖率是整轮扫描聚合值，属 L3/评分阶段；提交钩子不判它们
        expect(runner.evaluatePostScanGates).not.toHaveBeenCalled();
        expect(logs.join('\n')).toContain('RULE-REPORT');
      } finally {
        await cleanup();
      }
    });
  });
});
