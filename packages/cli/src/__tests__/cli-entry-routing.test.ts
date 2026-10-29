import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
    /** loadSopRulesFromCache 的返回值（0 = 未装载云端规则） */
    syncedCount: 0,
    /** evaluatePostScanGates 的返回；null = 空规则集 */
    gateReport: null as unknown,
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
      async loadSopRulesFromCache(): Promise<number> {
        return state.syncedCount;
      }
      getSopStats(): { total: number; active: number } {
        return { total: state.ruleCount + state.syncedCount, active: state.ruleCount };
      }
      evaluatePostScanGates(): unknown {
        return (
          state.gateReport ?? {
            total: 0,
            passed: 0,
            failed: 0,
            undetermined: 0,
            blockingFailed: 0,
            blockingUndetermined: 0,
            ok: true,
            complete: true,
            items: [],
          }
        );
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
    formatGateItems: (report: { items: Array<{ ruleId: string; message: string }> }) =>
      report.items.map((i) => `${i.ruleId}: ${i.message}`),
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
    state.syncedCount = 0;
    state.gateReport = null;
    state.runSopGuardCalls = 0;
    state.guardReport = null;
    state.inspectReport = null;
    state.sopGuardReport = null;
    // 固定云端缓存探测结果：不设则当前机器真实存在
    // ~/Library/.../sop-cache（52 条），用例结果会随开发机环境漂移。
    vi.stubEnv('ZH_SOP_CACHE_DIR', path.join(os.tmpdir(), 'zh-cli-entry-no-such-cache'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it('Given --sop 且规则注册为 0 条，When 启动 CLI 跑 guard，Then 输出盲检降级警告并以 exit 2 拦停', async () => {
    state.ruleCount = 0;
    state.sopGuardReport = sopRuleEngineReport();
    await runCli('guard', '--sop');

    expect(state.runSopGuardCalls).toBe(1);
    expect(firstExitCode()).toBe(2);
    expect(errors.join('\n')).toContain('SOP 规则注册 0 条');
    expect(errors.join('\n')).toContain('降级警告');
    expect(errors.join('\n')).toContain('盲检');
  });

  it('Given --sop 且云端缓存可用，When 启动 CLI，Then 横幅报出云端条数——只报"已加载 N 条"无法分辨云端进没进来', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-cli-cache-'));
    fs.mkdirSync(path.join(cacheDir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'modules', 'quality.db'), '[]');
    vi.stubEnv('ZH_SOP_CACHE_DIR', cacheDir);

    state.ruleCount = 43;
    state.syncedCount = 52;
    await runCli('guard', '--sop');

    const text = errors.join('\n');
    expect(text).toContain('云端同步 52 条');
    expect(text).toContain('内置模板 43 条');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('Given --sop 且门禁规则未达标，When 启动 CLI，Then exit 1——门禁必须能拦住命令出口，否则只是打印', async () => {
    state.ruleCount = 43;
    state.sopGuardReport = sopRuleEngineReport();
    state.gateReport = {
      total: 1,
      passed: 0,
      failed: 1,
      undetermined: 0,
      blockingFailed: 1,
      blockingUndetermined: 0,
      ok: false,
      complete: true,
      items: [{ ruleId: 'guard.block.official.test-coverage', status: 'failed', blocking: true, message: '覆盖率 0 < 80' }],
    };
    await runCli('guard', '--sop');

    expect(firstExitCode()).toBe(1);
    expect(errors.join('\n')).toContain('未达标 — 阻断');
  });

  it('Given --sop 且云端规则未加载导致门禁为空，When 启动 CLI，Then 明示"没有任何门禁结论"——这正是 pre-commit 假绿的成因', async () => {
    state.ruleCount = 43;
    state.sopGuardReport = sopRuleEngineReport();
    await runCli('guard', '--sop');

    const text = errors.join('\n');
    expect(text).toContain('未加载云端规则');
    expect(text).toContain('empty ≠ passed');
  });
});
