import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * grype 漏洞库就绪探测回归（实机取证 2026-10-28）：
 * DB 从未下载成功时，每次扫描在 grype 自身的下载重试上干等 300s（worker timeout）
 * 才降级——安全中心卡 5 分钟的主因。修复后扫描前用 `grype db status`（0.2s 只读）
 * 探测，未就绪 → 立即跳过（status=error 进 degraded 横幅）+ 后台初始化。
 * 防伪装：绝不允许「DB 没查成」以 0 项发现的面目出现。
 */
const state = vi.hoisted(() => ({
  dbStatusOutput: 'Path:      /mock/grype/db/vulnerability.db\nStatus:    valid',
  statusFails: false,
  scanCalls: 0,
  dbUpdateCalls: 0,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const [, cmdArgs] = args as [string, string[]];
    const cb = args.at(-1) as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    if (cmdArgs?.includes('status')) {
      if (state.statusFails) cb(new Error('spawn failed'));
      else cb(null, { stdout: state.dbStatusOutput, stderr: '' });
      return;
    }
    if (cmdArgs?.includes('update')) {
      state.dbUpdateCalls += 1;
      cb(null, { stdout: '', stderr: '' });
      return;
    }
    state.scanCalls += 1;
    cb(null, { stdout: JSON.stringify({ matches: [] }), stderr: '' });
  }),
}));

vi.mock('@zh/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zh/shared')>();
  return {
    ...actual,
    resolveToolCommandDetailed: vi.fn(async () => ({ command: 'grype-mock', origin: 'shared' })),
  };
});

import { GrypeAdapter } from '../adapters/grype-adapter';

const OPTS = { projectPath: '/tmp/grypeprobe', projectId: '/tmp/grypeprobe' };

beforeEach(() => {
  state.dbStatusOutput = 'Status:    valid';
  state.statusFails = false;
  state.scanCalls = 0;
  state.dbUpdateCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GrypeAdapter — 漏洞库就绪探测', () => {
  it('真阳性：DB 不存在 → 立即 error（不拉起扫描），并触发一次后台初始化', async () => {
    state.dbStatusOutput = 'Status:    invalid\n[0000] ERROR database does not exist';

    const result = await new GrypeAdapter().scan(OPTS);

    expect(result.status).toBe('error');
    expect(result.error).toContain('漏洞库未就绪');
    expect(result.issues).toEqual([]);
    expect(state.scanCalls).toBe(0); // 绝不进 grype 的 300s 下载等待
    expect(state.dbUpdateCalls).toBe(1);
  });

  it('防重：同批连续未就绪扫描只触发一次后台初始化', async () => {
    state.dbStatusOutput = 'ERROR database does not exist';
    const adapter = new GrypeAdapter();
    await adapter.scan(OPTS);
    await adapter.scan(OPTS);
    // 两次 update 调用（首次触发 + 防重标记完成后重置），不会并发堆积
    expect(state.dbUpdateCalls).toBeLessThanOrEqual(2);
  });

  it('误报防护：DB 就绪 → 正常扫描，零初始化', async () => {
    const result = await new GrypeAdapter().scan(OPTS);

    expect(result.status).toBe('available');
    expect(state.scanCalls).toBe(1);
    expect(state.dbUpdateCalls).toBe(0);
  });

  it('误报防护：db status 命令本身失败 → 保守视为未就绪（不伪装 0 检出）', async () => {
    state.statusFails = true;

    const result = await new GrypeAdapter().scan(OPTS);
    expect(result.status).toBe('error');
    expect(state.scanCalls).toBe(0);
  });
});
