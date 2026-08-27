import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SemgrepOutput } from '../adapters/tool-output-types';

// Mutable state accessible from vi.mock factories via vi.hoisted
const state = vi.hoisted(() => ({ mockStdout: '' }));

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
  existsSync: vi.fn(() => true),
}));

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
    expect(
      result.issues[0].codeFlows![0].threadFlows[0].locations,
    ).toHaveLength(1);
    expect(
      result.issues[0].codeFlows![0].threadFlows[0].locations[0].location.file,
    ).toBe('a.ts');
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
                        { location: { path: 'src/source.ts', start: { line: 2, col: 3 } }, message: 'entry' },
                        { location: { path: 'src/vuln.ts', start: { line: 10, col: 5 } }, message: 'sink' },
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
