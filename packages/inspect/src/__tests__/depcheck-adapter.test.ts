import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { DepcheckAdapter, buildDepcheckArgs } from '../adapters/depcheck-adapter';

const execFileMock = vi.mocked(execFile);

function mockSuccess(stdout: string): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr: '' });
  }) as never);
}

describe('buildDepcheckArgs', () => {
  it('merges default ignore list with config ignore list', () => {
    const args = buildDepcheckArgs(
      { projectPath: '/work', config: { ignore: ['foo'] } } as never,
      '/work',
    );
    expect(args).toEqual([
      '/work',
      '--json',
      '--ignore',
      '@types/*',
      '--ignore',
      'typescript',
      '--ignore',
      'eslint',
      '--ignore',
      'prettier',
      '--ignore',
      'foo',
    ]);
  });

  it('dedupes ignore entries overlapping the default list', () => {
    const args = buildDepcheckArgs(
      { projectPath: '/work', config: { ignore: ['typescript', 'foo'] } } as never,
      '/work',
    );
    const ignoreValues = args.filter((_a, i) => args[i - 1] === '--ignore');
    expect(ignoreValues).toEqual(['@types/*', 'typescript', 'eslint', 'prettier', 'foo']);
  });

  it('uses default ignore list when config has no ignore', () => {
    const args = buildDepcheckArgs({ projectPath: '/work' } as never, '/work');
    expect(args).toEqual([
      '/work',
      '--json',
      '--ignore',
      '@types/*',
      '--ignore',
      'typescript',
      '--ignore',
      'eslint',
      '--ignore',
      'prettier',
    ]);
  });
});

describe('DepcheckAdapter', () => {
  let adapter: DepcheckAdapter;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DepcheckAdapter();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcheck-adapter-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        devDependencies: { typescript: '^5.0.0', foo: '^1.0.0' },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps default ignores active when config ignore is provided', async () => {
    mockSuccess(
      JSON.stringify({
        dependencies: [],
        devDependencies: ['typescript', 'foo'],
        missing: {},
        using: {},
      }),
    );
    const result = await adapter.scan({
      projectPath: tmpDir,
      config: { ignore: ['foo'] },
    } as never);

    expect(result.status).toBe('available');

    const scanCall = execFileMock.mock.calls.find((c) =>
      (c[1] as string[]).includes('--json'),
    );
    expect(scanCall).toBeDefined();
    const args = scanCall![1] as string[];
    expect(args).toContain('typescript');
    expect(args).toContain('foo');
  });
});