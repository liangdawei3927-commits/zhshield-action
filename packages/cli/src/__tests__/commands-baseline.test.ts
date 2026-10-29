import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PipelineRunner } from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from '../cli-options';
import { runBaselineCommand } from '../commands';
import { saveBaseline, baselinePath } from '@zh/shared';

// 本文件验证 baseline 子命令（capture/list/clear）的落盘与展示契约：
// 基线是「可审计豁免」的载体——capture 必须对直扫与 SOP 两个来源去重，
// list 必须让过期条目与缺失理由可见，否则豁免清单会静默腐化成仪式。

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
  throw new Error('命令未按契约调用 process.exit');
}

function makeOpts(overrides: Partial<CLIOptions>): CLIOptions {
  return {
    command: 'baseline',
    dir: '',
    dryRun: false,
    sop: false,
    verbose: false,
    color: false,
    help: false,
    format: 'text',
    report: '',
    failOn: 'none',
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
function makeReporter(): ConsoleReporter {
  return { format: vi.fn() } as unknown as ConsoleReporter;
}

describe('runBaselineCommand — 基线子命令（capture / list / clear）', () => {
  let projectDir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    stubProcessExit();
    process.exitCode = undefined;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-cli-baseline-'));
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
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('Given 直扫 2 条 + SOP 2 条且其中 1 条与直扫完全重复，When capture，Then 去重后写入 3 条基线', async () => {
    // 绝对路径触发基线条目的 file 归一化（相对 projectDir + 正斜杠）
    const dupFile = path.join(projectDir, 'src', 'a.ts');
    const runner = makeRunner({
      runInspect: vi.fn(async () => ({
        issues: [
          { ruleId: 'r.dup', file: dupFile, line: 10, column: 2 },
          { ruleId: 'r.only-direct', file: path.join(projectDir, 'src', 'b.ts'), line: 1, column: 0 },
        ],
      })),
      runSopInspect: vi.fn(async () => ({
        evaluations: [
          {
            violations: [
              // 与直扫同 ruleId/file/line/column —— 同一匹配键，应被去重
              { ruleId: 'r.dup', file: dupFile, line: 10, column: 2 },
              { ruleId: 'r.only-sop', file: path.join(projectDir, 'src', 'c.ts'), line: 5, column: 0 },
            ],
          },
        ],
      })),
    });

    const code = await exitCodeOf(() =>
      runBaselineCommand(
        runner,
        makeOpts({ baselineAction: 'capture' }),
        makeReporter(),
        projectDir,
      ),
    );

    expect(code).toBeUndefined(); // ≡ exit 0
    // 两个来源都必须带 skipBaseline 执行，避免捕获时被既有基线过滤掉条目
    expect(runner.runInspect).toHaveBeenCalledWith({ skipBaseline: true });
    expect(runner.runSopInspect).toHaveBeenCalledWith(undefined, { skipBaseline: true });

    const baseline = JSON.parse(fs.readFileSync(baselinePath(projectDir), 'utf-8')) as {
      version: number;
      entries: Array<{ ruleId: string; file: string; line: number; column: number }>;
    };
    expect(baseline.version).toBe(1);
    expect(baseline.entries).toHaveLength(3);
    const ruleIds = baseline.entries.map((e) => e.ruleId).sort();
    expect(ruleIds).toEqual(['r.dup', 'r.only-direct', 'r.only-sop']);
    // 绝对路径已相对化，基线在仓库间可移植
    const dup = baseline.entries.find((e) => e.ruleId === 'r.dup')!;
    expect(dup.file).toBe('src/a.ts');

    const output = logs.join('\n');
    expect(output).toContain('直扫 2 + SOP 2，去重后 3');
    // 提示语必须出现：无 reason/owner 的条目不算可审计豁免
    expect(output).toContain('可审计豁免');
  });

  it('Given 项目尚无基线文件，When list，Then 明确提示未捕获并 exit 0——不得误报空基线为 0 项', async () => {
    const runner = makeRunner({});

    const code = await exitCodeOf(() =>
      runBaselineCommand(runner, makeOpts({ baselineAction: 'list' }), makeReporter(), projectDir),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('尚未捕获基线');
  });

  it('Given 含活跃（带理由/责任人/到期）、永久无理由、已过期三类条目的基线，When list，Then 审计字段与过期标注全部可见', async () => {
    await saveBaseline(projectDir, [
      {
        ruleId: 'r.active',
        file: 'src/a.ts',
        line: 10,
        column: 0,
        reason: '上游库误报，等待修复版本',
        owner: 'alice',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      {
        ruleId: 'r.permanent',
        file: 'src/b.ts',
        line: 2,
        column: 0,
      },
      {
        ruleId: 'r.expired',
        file: 'src/old.ts',
        line: 3,
        column: 0,
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    const runner = makeRunner({});

    const code = await exitCodeOf(() =>
      runBaselineCommand(runner, makeOpts({ baselineAction: 'list' }), makeReporter(), projectDir),
    );

    expect(code).toBeUndefined();
    const output = logs.join('\n');
    expect(output).toContain('基线 3 项');
    expect(output).toContain('捕获于');
    expect(output).toContain('其中 1 项已过期');
    expect(output).toContain('[已过期]');
    expect(output).toContain('理由: 上游库误报，等待修复版本');
    expect(output).toContain('责任人: alice');
    expect(output).toContain('2027-01-01');
    // 缺失理由的条目必须显式暴露，静默豁免无法复核；永久条目必须显式标注而非隐藏到期概念
    expect(output).toContain('[未记录理由]');
    expect(output).toContain('[永久]');
  });

  it('Given 已存在的基线文件，When clear，Then 文件被删除且输出清除路径', async () => {
    await saveBaseline(projectDir, [{ ruleId: 'r1', file: 'a.ts', line: 1, column: 0 }]);
    expect(fs.existsSync(baselinePath(projectDir))).toBe(true);
    const runner = makeRunner({});

    const code = await exitCodeOf(() =>
      runBaselineCommand(runner, makeOpts({ baselineAction: 'clear' }), makeReporter(), projectDir),
    );

    expect(code).toBeUndefined();
    expect(fs.existsSync(baselinePath(projectDir))).toBe(false);
    expect(logs.join('\n')).toContain('基线已清除');
  });

  it('Given 未知 baseline 子命令，When 执行，Then exit 1 并提示合法子命令——静默走默认动作会掩盖拼写错误', async () => {
    const runner = makeRunner({});

    const code = await exitCodeOf(() =>
      runBaselineCommand(
        runner,
        makeOpts({ baselineAction: 'bogus' as unknown as 'list' }),
        makeReporter(),
        projectDir,
      ),
    );

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('未知 baseline 子命令');
    expect(errors.join('\n')).toContain('capture | list | clear');
  });
});
