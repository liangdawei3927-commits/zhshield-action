import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PipelineRunner } from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from '../cli-options';
import { runInspectCommand, runRefactorCommand } from '../commands';

// 本文件验证 Inspect / Refactor 两个命令的路由与退出码语义：
// inspect 的差异化语义（默认仅报告、显式 --fail-on 才阻断）直接影响用户
// 「巡检不拦停」的使用预期；refactor 报告的错误异味同样要能拦停 CI。

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
    command: 'inspect',
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

/** InspectionReport 最小形态：buildFindings 识别该形态需 issues 数组 + summary + score 字段 */
function makeInspectionReport(issues: unknown[], adapterResults: unknown[] = []) {
  return {
    projectId: 'p',
    timestamp: new Date(),
    scanType: 'full',
    duration: 1,
    score: { overall: 50, grade: 'D' },
    issues,
    summary: { total: issues.length, error: issues.length, warning: 0, info: 0 },
    adapterResults,
    recommendations: [],
  };
}

function errorIssue(file = 'src/a.ts') {
  return { ruleId: 'inspect.r1', severity: 'error', message: '发现问题', file, line: 3, column: 0 };
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

describe('runInspectCommand — Inspect 巡检命令', () => {
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

  it('Given 显式 failOn=error 且巡检发现 error 级问题，When inspect，Then exit 1——用户显式要求巡检也参与门禁', async () => {
    const runner = makeRunner({
      runInspect: vi.fn(async () => makeInspectionReport([errorIssue()])),
      runSopInspect: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runInspectCommand(runner, makeOpts({ failOn: 'error' }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(1);
    expect(runner.runInspect).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('TEXT-REPORT');
  });

  it('Given failOn=none 且存在 error 级问题，When inspect，Then 不阻断——巡检默认仅报告，不打断开发者工作流', async () => {
    const runner = makeRunner({
      runInspect: vi.fn(async () => makeInspectionReport([errorIssue()])),
      runSopInspect: vi.fn(async () => makeRuleEngineReport([])),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runInspectCommand(runner, makeOpts({ failOn: 'none' }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined();
  });

  it('Given --sop 且 SOP 巡检规则失败（含违规），When inspect，Then 走 SOP 分支并以 exit 1 阻断', async () => {
    const sopReport = makeRuleEngineReport(
      [
        {
          rule: { id: 'inspect.scan.complexity', name: '复杂度检测' },
          status: 'failed',
          message: '发现 1 处问题',
          violations: [
            {
              id: 'v1',
              ruleId: 'inspect.scan.complexity',
              severity: 'error',
              file: 'src/big.ts',
              line: 10,
              message: '函数过长',
            },
          ],
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
      ],
      { ok: false },
    );
    const runner = makeRunner({
      runInspect: vi.fn(async () => makeInspectionReport([])),
      runSopInspect: vi.fn(async () => sopReport),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runInspectCommand(runner, makeOpts({ sop: true }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(1);
    expect(runner.runSopInspect).toHaveBeenCalledTimes(1);
    expect(runner.runInspect).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('RULE-REPORT');
  });

  it('Given --sop 且巡检报告 degraded>0（适配器被降级跳过），When inspect，Then exit 2——巡检降级同样不得伪装成通过', async () => {
    const sopReport = makeRuleEngineReport(
      [
        {
          rule: { id: 'inspect.scan.security.semgrep', name: 'Semgrep 扫描' },
          status: 'skipped',
          degraded: true,
          message: 'semgrep 不可用',
          durationMs: 0,
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
      ],
      { degraded: 1, ok: true },
    );
    const runner = makeRunner({
      runInspect: vi.fn(async () => makeInspectionReport([])),
      runSopInspect: vi.fn(async () => sopReport),
    });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runInspectCommand(runner, makeOpts({ sop: true }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('降级警告');
  });
});

describe('runRefactorCommand — Refactor 重构检测命令', () => {
  let logs: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  /** RefactorReport 最小形态：buildFindings 识别该形态需 files 数组 + bySeverity */
  function makeRefactorReport(smells: unknown[]) {
    return {
      files: [
        {
          filePath: 'src/big.ts',
          smells,
          refactorPriority: 'high',
          totalSmells: smells.length,
          maintainabilityScore: 40,
        },
      ],
      bySeverity: { error: smells.length },
      totalSmells: smells.length,
      totalFiles: 1,
      scannedFiles: 1,
      timestamp: new Date().toISOString(),
      summary: { criticalFiles: 0, needsImmediateAction: 0 },
    };
  }

  it('Given error 级代码异味且 failOn=error，When refactor，Then exit 1——重构债中的 error 级问题必须拦停流水线', async () => {
    const report = makeRefactorReport([
      {
        ruleId: 'refactor.long-function',
        severity: 'error',
        message: '函数过长',
        location: { filePath: 'src/big.ts', line: 12, column: 3 },
        category: 'complexity',
        suggestion: { description: '拆分函数' },
      },
    ]);
    const runner = makeRunner({ runRefactor: vi.fn(async () => report) });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runRefactorCommand(runner, makeOpts({ command: 'refactor' }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBe(1);
    expect(runner.runRefactor).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('TEXT-REPORT');
  });

  it('Given 无任何代码异味，When refactor，Then exit 0——干净项目不得误报', async () => {
    const report = makeRefactorReport([]);
    const runner = makeRunner({ runRefactor: vi.fn(async () => report) });
    const reporter = makeReporter();

    const code = await exitCodeOf(() =>
      runRefactorCommand(runner, makeOpts({ command: 'refactor' }), reporter as unknown as ConsoleReporter, '/proj'),
    );

    expect(code).toBeUndefined();
  });
});
