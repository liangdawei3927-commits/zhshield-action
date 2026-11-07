/**
 * A12 执行面：一次运行内同一 (command, argv, cwd) 只起一次进程
 *
 * 背景（2026-11-03 进程级实测，`scripts/lib/tool-spy.cjs`）：
 *   一轮 `--full` 里 `gitleaks detect --source <项目> --report-format json --report-path - --no-git`
 *   被起了 3 次、argv 逐字节相同 —— inspect 与 security 各有一套调用实现。
 *
 * 本文件锁住五件事，改动实现前先读：
 *   ① 作用域内同参只执行一次，结果重放
 *   ② 非零退出（如 gitleaks 命中时 exit 1 带合法 JSON）也要重放，且**错误快照可克隆** ——
 *      调用方"从失败输出里捞 findings"的语义不能变
 *   ③ 超时/被信号杀掉不缓存（那是"没测出来"，必须可重试）
 *   ④ 作用域外行为与直接 execFile 等价（长驻进程不得跨扫描复用结论）
 *   ⑤ 嵌套作用域复用同一个（不碎片化缓存）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spawns: Array<{ command: string; args: string[] }> = [];
let behavior: 'ok' | 'nonzero-with-stdout' | 'timeout' | 'enoent' = 'ok';

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    _options: unknown,
    callback: (err: unknown, stdout?: string, stderr?: string) => void,
  ) => {
    spawns.push({ command, args });
    if (behavior === 'enoent') {
      callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      return;
    }
    if (behavior === 'timeout') {
      callback(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }));
      return;
    }
    if (behavior === 'nonzero-with-stdout') {
      // 与 Node 一致：非零退出时 error 上带 code，stdout 作为第三个参数独立传入
      callback(Object.assign(new Error('exit 1'), { code: 1 }), '[{"RuleID":"generic-api-key"}]', '');
      return;
    }
    callback(null, 'ok-out', '');
  },
}));

const { runToolOnce, withToolRunScope, currentToolRunScope, runOncePerScope } = await import(
  '../tool-run-scope'
);

describe('runToolOnce — 运行作用域内同参只执行一次', () => {
  beforeEach(() => {
    spawns.length = 0;
    behavior = 'ok';
  });

  it('作用域内两次相同调用只起一次进程，结果一致', async () => {
    const results = await withToolRunScope('test', async () => [
      await runToolOnce('gitleaks', ['detect', '--source', '/p']),
      await runToolOnce('gitleaks', ['detect', '--source', '/p']),
    ]);

    expect(spawns).toHaveLength(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].stdout).toBe('ok-out');
  });

  it('并发同时到达也只起一次（in-flight 共享，不是"先查表再各跑"）', async () => {
    const results = await withToolRunScope('test', () =>
      Promise.all([
        runToolOnce('semgrep', ['scan', '/p']),
        runToolOnce('semgrep', ['scan', '/p']),
        runToolOnce('semgrep', ['scan', '/p']),
      ]),
    );
    expect(spawns).toHaveLength(1);
    expect(results.every((r) => r.stdout === 'ok-out')).toBe(true);
  });

  it('argv 或 cwd 不同则各执行一次（不能把不同扫描折叠成一个）', async () => {
    await withToolRunScope('test', async () => {
      await runToolOnce('gitleaks', ['detect', '--source', '/a']);
      await runToolOnce('gitleaks', ['detect', '--source', '/b']);
      await runToolOnce('gitleaks', ['detect', '--source', '/a'], { cwd: '/repo' });
    });
    expect(spawns).toHaveLength(3);
  });

  it('非零退出 + stdout 同样重放：错误快照带 stdout，调用方捞 findings 的语义不变', async () => {
    behavior = 'nonzero-with-stdout';

    const caught = await withToolRunScope('test', async () => {
      const errors: Array<{ stdout?: string; code?: unknown }> = [];
      for (let i = 0; i < 2; i += 1) {
        try {
          await runToolOnce('gitleaks', ['detect', '--source', '/p']);
        } catch (err) {
          errors.push(err as { stdout?: string; code?: unknown });
        }
      }
      return errors;
    });

    expect(spawns).toHaveLength(1); // gitleaks 命中密钥时的 exit 1 不该导致重扫
    expect(caught).toHaveLength(2);
    expect(caught[0].stdout).toContain('generic-api-key');
    expect(caught[1].stdout).toContain('generic-api-key');
    expect(caught[0].code).toBe(1);
  });

  it('超时/被信号杀掉不缓存：抖动过去后重试必须真的重扫', async () => {
    behavior = 'timeout';
    await withToolRunScope('test', async () => {
      await expect(runToolOnce('semgrep', ['scan', '/p'])).rejects.toThrow();
    });

    behavior = 'ok';
    const out = await withToolRunScope('test', () => runToolOnce('semgrep', ['scan', '/p']));
    expect(spawns).toHaveLength(2);
    expect(out.stdout).toBe('ok-out');
  });

  it('ENOENT（确定不存在）是结论明确，重放不重探', async () => {
    behavior = 'enoent';
    const errors = await withToolRunScope('test', async () => {
      const seen: unknown[] = [];
      for (let i = 0; i < 2; i += 1) {
        try {
          await runToolOnce('missing-tool', ['--version']);
        } catch (err) {
          seen.push((err as { code?: unknown }).code);
        }
      }
      return seen;
    });
    expect(spawns).toHaveLength(1);
    expect(errors).toEqual(['ENOENT', 'ENOENT']);
  });

  it('作用域外不共享：两次调用各执行一次（长驻进程不得跨扫描复用结论）', async () => {
    await runToolOnce('gitleaks', ['detect', '--source', '/p']);
    await runToolOnce('gitleaks', ['detect', '--source', '/p']);
    expect(spawns).toHaveLength(2);
    expect(currentToolRunScope()).toBeUndefined();
  });

  it('嵌套作用域复用同一个 scope（不碎片化缓存）', async () => {
    await withToolRunScope('outer', async () => {
      const outer = currentToolRunScope();
      await withToolRunScope('inner', async () => {
        expect(currentToolRunScope()).toBe(outer);
        await runToolOnce('gitleaks', ['detect', '--source', '/p']);
      });
      await runToolOnce('gitleaks', ['detect', '--source', '/p']);
      expect(outer?.hits).toBe(1); // 内层已执行，外层命中重放
    });
    expect(spawns).toHaveLength(1);
  });
});

/**
 * `runOncePerScope`：不是扫描的"一次性调用"（当前用于 `--version` 探测）。
 *
 * 为什么要独立于 `runToolOnce`：探测结果是 `ToolProbeResult`，不是 `ToolRunOutcome`；
 * 混进 `calls` 会让"派发次数"与"缓存条数"对不上，A12 的账本就再也读不准。
 * 语义保持一致：只保留结论明确的结果，失败不留残影。
 */
describe('runOncePerScope — 作用域内同一 key 只算一次', () => {
  beforeEach(() => {
    spawns.length = 0;
    behavior = 'ok';
  });

  it('作用域内三次调用只真跑一次，返回值共享', async () => {
    let runs = 0;
    const run = async (): Promise<string> => {
      runs += 1;
      return 'probed';
    };
    const values = await withToolRunScope('test', async () => [
      await runOncePerScope('ns', 'key-1', run),
      await runOncePerScope('ns', 'key-1', run),
      await runOncePerScope('ns', 'key-1', run),
    ]);
    expect(runs).toBe(1);
    expect(values).toEqual(['probed', 'probed', 'probed']);
  });

  it('不同 namespace / key 互不影响', async () => {
    let runs = 0;
    const run = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    await withToolRunScope('test', async () => {
      await runOncePerScope('probe', 'k', run);
      await runOncePerScope('other', 'k', run);
      await runOncePerScope('probe', 'k2', run);
    });
    expect(runs).toBe(3);
  });

  it('keep 返回 false 的结果不留在表里：下次调用真的重跑', async () => {
    let runs = 0;
    const run = async (): Promise<{ conclusive: boolean }> => {
      runs += 1;
      return { conclusive: runs > 1 }; // 首次"没测出来"
    };
    await withToolRunScope('test', async () => {
      const first = await runOncePerScope('probe', 'k', run, (v) => v.conclusive);
      expect(first.conclusive).toBe(false);
      const second = await runOncePerScope('probe', 'k', run, (v) => v.conclusive);
      expect(second.conclusive).toBe(true); // 真的重跑了
      const third = await runOncePerScope('probe', 'k', run, (v) => v.conclusive);
      expect(third).toBe(second); // 结论明确后重放
    });
    expect(runs).toBe(2);
  });

  it('作用域外不共享（长驻进程不得跨扫描复用）', async () => {
    let runs = 0;
    const run = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    await runOncePerScope('probe', 'k', run);
    await runOncePerScope('probe', 'k', run);
    expect(runs).toBe(2);
  });
});
