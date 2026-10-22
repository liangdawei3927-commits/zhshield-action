import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';

// 本文件驱动真实 CLI 入口 index.ts（含模块加载即执行的 main()），
// 用 mock 的 PipelineRunner 隔离引擎层，验证用户直接触面的行为契约：
//   1. 参数解析 → 命令路由 → 退出码 的完整链路；
//   2. help / 未知命令 / 非法 --fail-on 的输入兜底；
//   3. inspect 默认 fail-on=none（仅报告）与 guard 默认 error（阻断）的行为差异。
// 注意：process.exit 在此采用「记录退出码但不终止进程」的策略，
// 使 main() 自然走完（无未处理拒绝），退出码取首次记录值即真实语义。

const state = vi.hoisted(() => {
  return {
    constructed: [] as Array<{ projectDir: string; options: unknown }>,
    ruleCount: 3,
    guardReport: null as unknown,
    inspectReport: null as unknown,
    sopGuardReport: null as unknown,
    runSopGuardCalls: 0,
  };
});

vi.mock('@zh/pipeline', () => {
  return {
    PipelineRunner: class {
      projectDir: string;
      options: unknown;
      constructor(projectDir: string, options?: unknown) {
        this.projectDir = projectDir;
        this.options = options;
        state.constructed.push({ projectDir, options });
      }
      async loadSopRules(): Promise<number> {
        return state.ruleCount;
      }
      async runGuard(): Promise<unknown> {
        return state.guardReport;
      }
      async runInspect(): Promise<unknown> {
        return state.inspectReport;
      }
      async runSopGuard(): Promise<unknown> {
        state.runSopGuardCalls += 1;
        return state.sopGuardReport;
      }
      async destroy(): Promise<void> {}
    },
  };
});

/** 带违规的 GuardReport 最小形态：真实 ConsoleReporter 可直接渲染 */
function guardReportWithViolation() {
  return {
    ok: false,
    mode: 'guard',
    target: '/proj',
    timestamp: new Date(),
    summary: { total: 1, passed: 0, failed: 1 },
    results: [
      { checkId: 'guard.chk.eslint', status: 'failed', severity: 'error', message: '存在 ESLint 错误' },
    ],
  };
}

/** 带违规的 InspectionReport 最小形态 */
function inspectionReportWithIssue() {
  return {
    projectId: 'p',
    timestamp: new Date(),
    scanType: 'full',
    duration: 1,
    score: { overall: 50, grade: 'D' },
    issues: [
      { ruleId: 'inspect.r1', severity: 'error', message: '发现问题', file: 'src/a.ts', line: 3, column: 0 },
    ],
    summary: { total: 1, error: 1, warning: 0, info: 0 },
    adapterResults: [],
    recommendations: [],
  };
}

/** 全部通过的 SOP 引擎报告（空规则集） */
function sopRuleEngineReport() {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok: true,
    evaluations: [],
    durationMs: 0,
    timestamp: new Date(),
  };
}

describe('CLI 入口路由（真实 index.ts + mock 引擎）', () => {
  let exitCodes: Array<number | undefined>;
  let logs: string[];
  let errors: string[];
  let savedArgv: string[];
  let savedExitCode: number | string | null | undefined;

  beforeEach(() => {
    exitCodes = [];
    logs = [];
    errors = [];
    savedArgv = process.argv;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCodes.push(code == null ? undefined : Number(code));
      return undefined as never;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    state.constructed = [];
    state.ruleCount = 3;
    state.runSopGuardCalls = 0;
    state.guardReport = null;
    state.inspectReport = null;
    state.sopGuardReport = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  });

  /** 重置模块缓存后重新加载 CLI 入口（index.ts 顶层即执行 main()），等待其走到退出点 */
  async function runCli(...cliArgs: string[]): Promise<void> {
    process.argv = ['node', '/fake/zhshield.js', ...cliArgs];
    vi.resetModules();
    await import('../index');
    await vi.waitFor(() => {
      expect(exitCodes.length).toBeGreaterThan(0);
    });
  }

  /**
   * 真实语义：process.exit(code) 会立刻终止进程，之后的代码不可达。
   * mock 无法终止进程导致出口之后的代码继续执行（可能产生额外 exit 记录），
   * 因此以「首次」退出调用为准——它才是真实 CLI 对外暴露的退出码。
   * process.exit(undefined) ≡ 退出码 0。
   */
  function firstExitCode(): number {
    const code = exitCodes[0];
    return code ?? 0;
  }

  it('Given 无任何参数，When 启动 CLI，Then 打印用法并以 exit 0 结束——空输入是新手的第一触点，不得报错', async () => {
    await runCli();

    expect(firstExitCode()).toBe(0);
    expect(logs.join('\n')).toContain('用法:');
    expect(logs.join('\n')).toContain('zhshield guard');
  });

  it('Given 未知命令，When 启动 CLI，Then 提示未知命令与用法并 exit 1——静默吞掉拼写错误会让人以为检查通过了', async () => {
    await runCli('frobnicate');

    expect(firstExitCode()).toBe(1);
    expect(errors.join('\n')).toContain('未知命令: frobnicate');
    expect(logs.join('\n')).toContain('用法:');
  });

  it('Given guard 命令未传 --dir，When 启动 CLI，Then 以当前工作目录构造 PipelineRunner 并因 error 违规 exit 1', async () => {
    state.guardReport = guardReportWithViolation();
    await runCli('guard');

    expect(firstExitCode()).toBe(1);
    expect(state.constructed).toHaveLength(1);
    expect(state.constructed[0].projectDir).toBe(process.cwd());
  });

  it('Given guard 命令显式 --dir，When 启动 CLI，Then 以解析后的绝对路径构造 PipelineRunner——项目根漂移会让所有报告路径失真', async () => {
    state.guardReport = guardReportWithViolation();
    await runCli('guard', '--dir', '/custom/project');

    expect(state.constructed[0].projectDir).toBe(path.resolve('/custom/project'));
  });

  it('Given inspect 命令携带与 guard 相同的 error 违规，When 启动 CLI（不传 --fail-on），Then exit 0——inspect 默认仅报告不阻断', async () => {
    state.inspectReport = inspectionReportWithIssue();
    await runCli('inspect');

    expect(firstExitCode()).toBe(0);
  });

  it('Given 非法 --fail-on 值，When 启动 CLI，Then 首个退出码为 2 且给出合法值提示——非法阈值必须显式报错而非静默降级', async () => {
    state.guardReport = guardReportWithViolation();
    await runCli('guard', '--fail-on', 'critical');

    expect(exitCodes[0]).toBe(2);
    expect(errors.join('\n')).toContain('非法 --fail-on 值: critical');
    expect(errors.join('\n')).toContain('error | warning | info | none');
  });

  it('Given --sop 且规则加载为 0 条，When 启动 CLI 跑 guard，Then 输出盲检降级警告并以 exit 2 拦停', async () => {
    state.ruleCount = 0;
    state.sopGuardReport = sopRuleEngineReport();
    await runCli('guard', '--sop');

    expect(state.runSopGuardCalls).toBe(1);
    expect(firstExitCode()).toBe(2);
    expect(errors.join('\n')).toContain('已加载 0 条 SOP 规则');
    expect(errors.join('\n')).toContain('降级警告');
    expect(errors.join('\n')).toContain('盲检');
  });
});
