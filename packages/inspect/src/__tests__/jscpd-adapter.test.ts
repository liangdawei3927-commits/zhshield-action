import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('@zh/kernel', () => ({
  FileHelper: {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    readJSON: vi.fn(),
  },
}));

vi.mock('../adapters/tool-bin', () => ({
  resolveToolCommand: vi.fn().mockResolvedValue('/usr/bin/jscpd'),
}));

vi.mock('../adapters/tool-available', () => ({
  isCommandAvailable: vi.fn().mockResolvedValue(true),
}));

import { execFile } from 'node:child_process';
import { FileHelper } from '@zh/kernel';
import { JscpdAdapter } from '../adapters/jscpd-adapter';

const execFileMock = vi.mocked(execFile);
const readJSONMock = vi.mocked(FileHelper.readJSON);

function mockExecVersion(version: string): void {
  function impl(
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ): void {
    if (args.includes('--version')) {
      cb(null, { stdout: version, stderr: '' });
      return;
    }
    cb(null, { stdout: '', stderr: '' });
  }
  execFileMock.mockImplementation(impl as never);
}

function mockReadJSON(report: unknown): void {
  readJSONMock.mockResolvedValue(report as never);
}

describe('JscpdAdapter', () => {
  let adapter: JscpdAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new JscpdAdapter();
  });

  it('maps v5 firstFile/secondFile shape to file + line', async () => {
    mockExecVersion('5.0.14');
    mockReadJSON({
      duplicates: [
        {
          firstFile: { name: 'dup-a.ts', start: 13, end: 41, startLoc: { line: 13, column: 50 }, endLoc: { line: 41 } },
          secondFile: { name: 'dup-b.ts', start: 7, end: 35, startLoc: { line: 7, column: 10 }, endLoc: { line: 35 } },
          format: 'typescript',
          lines: 28,
          tokens: 245,
        },
      ],
      statistics: { detection: { total: { count: 1 } } },
    });

    const result = await adapter.scan({ projectPath: '/work' } as never);

    expect(result.status).toBe('available');
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.file).toBe('dup-a.ts');
    expect(issue.line).toBe(13);
    expect(issue.message).toContain('dup-a.ts:13');
    expect(issue.message).toContain('dup-b.ts:7');
    expect(issue.ruleId).toBe('jscpd/duplicate');
    expect(issue.severity).toBe('warning');
  });

  it('falls back to legacy first/second shape for jscpd <5', async () => {
    mockExecVersion('3.0.6');
    mockReadJSON({
      duplicates: [
        {
          first: { location: { path: 'src/a.ts', start: { line: 10 } } },
          second: { location: { path: 'src/b.ts', start: { line: 20 }, end: { line: 40 } } },
          format: 'typescript',
        },
      ],
    });

    const result = await adapter.scan({ projectPath: '/work' } as never);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.file).toBe('src/a.ts');
    expect(issue.line).toBe(10);
    expect(issue.message).toContain('src/a.ts:10');
    expect(issue.message).toContain('src/b.ts:20');
  });

  it('prefers firstFile over legacy first when both present', async () => {
    mockExecVersion('5.0.14');
    mockReadJSON({
      duplicates: [
        {
          firstFile: { name: 'v5-file.ts', startLoc: { line: 5 } },
          secondFile: { name: 'v5-other.ts', startLoc: { line: 8 } },
          first: { location: { path: 'legacy-file.ts', start: { line: 99 } } },
          second: { location: { path: 'legacy-other.ts', start: { line: 88 } } },
          format: 'typescript',
        },
      ],
    });

    const result = await adapter.scan({ projectPath: '/work' } as never);

    const issue = result.issues[0];
    expect(issue.file).toBe('v5-file.ts');
    expect(issue.line).toBe(5);
    expect(issue.message).toContain('v5-file.ts:5');
    expect(issue.message).toContain('v5-other.ts:8');
  });

  it('returns empty issues for empty duplicates', async () => {
    mockExecVersion('5.0.14');
    mockReadJSON({ duplicates: [] });

    const result = await adapter.scan({ projectPath: '/work' } as never);

    expect(result.issues).toHaveLength(0);
    expect(result.status).toBe('available');
  });

  it('returns empty when duplicates is missing', async () => {
    mockExecVersion('5.0.14');
    mockReadJSON({});

    const result = await adapter.scan({ projectPath: '/work' } as never);

    expect(result.issues).toHaveLength(0);
  });
});
