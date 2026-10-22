import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConsoleReporter } from '@zh/reporter';
import { handleError } from '../commands';

// handleError 是所有命令异常的统一出口：它决定进程以 exit 1 失败、
// 并把错误渲染成用户可读的报告而非裸堆栈。渲染形态或退出码回归，
// 会直接破坏 CI 的失败可见性（异常被吞成 0 退出码是最危险的静默）。

describe('handleError — 统一错误出口', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
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
  });

  function makeReporter() {
    return {
      format: vi.fn((): { text: string; passed: boolean } => ({ text: 'ERROR-REPORT', passed: false })),
    };
  }

  function captureExit(fn: () => void): number | undefined {
    const spy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      const err = new Error(`process.exit(${String(code)})`) as Error & { code?: number | string | null };
      err.code = code;
      throw err;
    });
    try {
      fn();
      throw new Error('handleError 未调用 process.exit——异常必须以失败退出码终止');
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e) {
        return (e as { code?: number | string | null }).code ?? undefined;
      }
      throw e;
    } finally {
      spy.mockRestore();
    }
  }

  it('Given Error 实例，When handleError，Then 渲染失败报告（error=message、全阶段置空）并以 exit 1 终止', () => {
    const reporter = makeReporter();

    const code = captureExit(() =>
      handleError(reporter as unknown as ConsoleReporter, new Error('GuardEngine 初始化失败')),
    );

    expect(code).toBe(1);
    const report = reporter.format.mock.calls[0][0] as {
      error: string;
      passed: boolean;
      guard: unknown;
      inspect: unknown;
      refactor: unknown;
      stage: string;
    };
    expect(report.error).toBe('GuardEngine 初始化失败');
    expect(report.passed).toBe(false);
    expect(report.guard).toBeNull();
    expect(report.inspect).toBeNull();
    expect(report.refactor).toBeNull();
    expect(report.stage).toBe('complete');
    // 报告必须打到 stderr（stdout 可能被机器可读输出占用）
    expect(errors.join('\n')).toContain('ERROR-REPORT');
  });

  it('Given 非 Error 抛出值（字符串），When handleError，Then String() 归一后仍 exit 1——异常路径不得因抛出值形态不同而漏报', () => {
    const reporter = makeReporter();

    const code = captureExit(() =>
      handleError(reporter as unknown as ConsoleReporter, '裸字符串错误'),
    );

    expect(code).toBe(1);
    const report = reporter.format.mock.calls[0][0] as { error: string };
    expect(report.error).toBe('裸字符串错误');
    expect(errors.join('\n')).toContain('ERROR-REPORT');
  });
});
