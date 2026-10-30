import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SemgrepOutput } from '../adapters/tool-output-types';

// Mutable state accessible from vi.mock factories via vi.hoisted
const state = vi.hoisted(() => ({ mockStdout: '', existsHighSeverity: false }));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args.at(-1) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout: state.mockStdout, stderr: '' });
  }),
}));

vi.mock('node:fs', () => ({
  // 默认「规则目录存在」；high-severity 子目录由用例显式开关——内置规则资产里
  // 并没有该子目录，适配器必须能回退到整目录 + --severity 过滤
  existsSync: vi.fn((p: unknown) =>
    String(p).includes('high-severity') ? state.existsHighSeverity : true,
  ),
  // adapter 在规则目录存在后还会调用 fs.promises.access 二次校验
  promises: { access: vi.fn(async () => undefined) },
}));

// @zh/shared 经 package.json exports 解析到 dist/ 并被 Vitest 外部化，故上面的
// node:child_process mock 覆盖不到其内部 tool-resolve —— 真实路径会 spawn 一次
// `semgrep --version`（Python 冷启动约 7.4s），使本文件耗时 6~17s/用例且依赖开发机
// 是否安装 semgrep。参见 guard-skip-semantics.test.ts 同处陷阱的说明。
vi.mock('@zh/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zh/shared')>();
  return {
    ...actual,
    resolveToolCommandDetailed: vi.fn(async () => ({
      command: 'semgrep',
      origin: 'path' as const,
    })),
  };
});

import { SemgrepAdapter } from '../adapters/semgrep-adapter';

function makeResult(overrides: Record<string, unknown>) {
  return {
    check_id: 'test-rule',
    path: 'src/vuln.ts',
    start: { line: 10, col: 5 },
    extra: { severity: 'ERROR', message: 'taint flow' },
    ...overrides,
  };
}

describe('SemgrepAdapter dataflow_trace → codeFlows', () => {
  beforeEach(() => {
    state.mockStdout = '';
    vi.clearAllMocks();
  });

  it('maps dataflow_trace to codeFlows when trace is present', async () => {
    const output: SemgrepOutput = {
      results: [
        makeResult({
          dataflow_trace: {
            code_flows: [
              {
                thread_flows: [
                  {
                    locations: [
                      {
                        location: { path: 'src/source.ts', start: { line: 1, col: 1 } },
                        message: 'user input enters here',
                      },
                      {
                        location: { path: 'src/vuln.ts', start: { line: 10, col: 5 } },
                        message: 'reaches SQL query',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ],
    };
    state.mockStdout = JSON.stringify(output);

    const result = await new SemgrepAdapter().scan({ projectPath: '/test' });

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.codeFlows).toBeDefined();
    expect(issue.codeFlows).toHaveLength(1);

    const [flow] = issue.codeFlows!;
    expect(flow.threadFlows).toHaveLength(1);
    expect(flow.threadFlows[0].locations).toHaveLength(2);
    expect(flow.threadFlows[0].locations[0]).toEqual({
      location: { file: 'src/source.ts', line: 1, column: 1 },
      message: 'user input enters here',
    });
    expect(flow.threadFlows[0].locations[1]).toEqual({
      location: { file: 'src/vuln.ts', line: 10, column: 5 },
      message: 'reaches SQL query',
    });
  });

  it('leaves codeFlows undefined when dataflow_trace is absent', async () => {
    const output: SemgrepOutput = {
      results: [makeResult({})],
    };
    state.mockStdout = JSON.stringify(output);

    const result = await new SemgrepAdapter().scan({ projectPath: '/test' });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].codeFlows).toBeUndefined();
  });

  it('leaves codeFlows undefined when code_flows array is empty', async () => {
    const output: SemgrepOutput = {
      results: [
        makeResult({
          dataflow_trace: { code_flows: [] },
        }),
      ],
    };
    state.mockStdout = JSON.stringify(output);

    const result = await new SemgrepAdapter().scan({ projectPath: '/test' });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].codeFlows).toBeUndefined();
  });

  it('skips locations with missing location sub-object', async () => {
    const output: SemgrepOutput = {
      results: [
        makeResult({
          dataflow_trace: {
            code_flows: [
              {
                thread_flows: [
                  {
                    locations: [
                      { location: { path: 'a.ts', start: { line: 1, col: 1 } }, message: 'ok' },
                      { message: 'no location object' },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ],
    };
    state.mockStdout = JSON.stringify(output);

    const result = await new SemgrepAdapter().scan({ projectPath: '/test' });

    expect(result.issues[0].codeFlows).toHaveLength(1);
    expect(result.issues[0].codeFlows![0].threadFlows[0].locations).toHaveLength(1);
    expect(result.issues[0].codeFlows![0].threadFlows[0].locations[0].location.file).toBe('a.ts');
  });

  it('maps extra.dataflow_trace (nested variant) to codeFlows as well', async () => {
    const output: SemgrepOutput = {
      results: [
        makeResult({
          extra: {
            severity: 'ERROR',
            message: 'taint flow',
            dataflow_trace: {
              code_flows: [
                {
                  thread_flows: [
                    {
                      locations: [
                        {
                          location: { path: 'src/source.ts', start: { line: 2, col: 3 } },
                          message: 'entry',
                        },
                        {
                          location: { path: 'src/vuln.ts', start: { line: 10, col: 5 } },
                          message: 'sink',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        }),
      ],
    };
    state.mockStdout = JSON.stringify(output);

    const result = await new SemgrepAdapter().scan({ projectPath: '/test' });

    expect(result.issues[0].codeFlows).toBeDefined();
    expect(result.issues[0].codeFlows![0].threadFlows[0].locations).toEqual([
      { location: { file: 'src/source.ts', line: 2, column: 3 }, message: 'entry' },
      { location: { file: 'src/vuln.ts', line: 10, column: 5 }, message: 'sink' },
    ]);
  });
});

// 快速模式（config.severity 含 ERROR）此前无条件指向 rulesDir/high-severity，
// 而内置规则资产从未提供该子目录 → semgrep 必然 "unable to find config" 报 error。
// 这里锁死「目录缺失时必须回退整目录 + --severity 过滤」这一行为契约。
describe('SemgrepAdapter 快速模式参数构造', () => {
  beforeEach(() => {
    state.mockStdout = JSON.stringify({ results: [] });
    vi.clearAllMocks();
  });

  async function lastScanArgs(): Promise<string[]> {
    const { execFile } =
      await vi.importMock<typeof import('node:child_process')>('node:child_process');
    const calls = (execFile as unknown as { mock: { calls: Array<[string, string[]]> } }).mock
      .calls;
    return calls.at(-1)![1];
  }

  it('规则目录没有 high-severity 子目录时，回退整目录并追加 --severity ERROR', async () => {
    state.existsHighSeverity = false;
    await new SemgrepAdapter().scan({ projectPath: '/test', config: { severity: ['ERROR'] } });

    const args = await lastScanArgs();
    expect(args[args.indexOf('--config') + 1]).not.toContain('high-severity');
    expect(args[args.indexOf('--severity') + 1]).toBe('ERROR');
  });

  it('规则目录提供 high-severity 子目录时，优先使用该目录且不再重复加 --severity', async () => {
    state.existsHighSeverity = true;
    await new SemgrepAdapter().scan({ projectPath: '/test', config: { severity: ['ERROR'] } });

    const args = await lastScanArgs();
    expect(args[args.indexOf('--config') + 1]).toContain('high-severity');
    expect(args).not.toContain('--severity');
  });

  it('非快速模式使用整目录，不做严重级过滤', async () => {
    state.existsHighSeverity = false;
    await new SemgrepAdapter().scan({ projectPath: '/test' });

    const args = await lastScanArgs();
    expect(args[args.indexOf('--config') + 1]).not.toContain('high-severity');
    expect(args).not.toContain('--severity');
  });
});
