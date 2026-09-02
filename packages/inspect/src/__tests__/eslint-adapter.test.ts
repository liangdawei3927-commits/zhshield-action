import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { ESLintAdapter } from '../adapters/eslint-adapter';

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

afterEach(() => {
  vi.resetAllMocks();
});

/**
 * 注入的 flat config（SOP 规则声明的相对路径）在被扫描项目内不存在时，
 * 适配器应退化为 unavailable（跳过该规则），而非让 ESLint 因 ENOENT 崩溃
 * 并导致整次巡检失败。这是 "越修复问题越多" 的根因之一。
 */
describe('ESLintAdapter 注入 config 缺失时的行为', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'eslint-adapter-test-'));
    // 让 resolveCommand 走本地 .bin 查找仍无法命中，但此处 verify 仅触发在 config 缺失分支
    // 之后，不会真的执行 ESLint，因此不需要真实 node_modules。
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('config 文件缺失时返回 unavailable 并跳过 ESLint 调用', async () => {
    // scan 先调用 resolveCommand（--version 探测命令可用），需放行该次调用
    mockSuccess('v9.39.5');
    const adapter = new ESLintAdapter(tempDir);
    const result = await adapter.scan({
      projectPath: tempDir,
      config: {
        // 注入一个真实不存在的内核资产路径（真实资产路径已可解析，不可再作为缺失样本）
        config: '@zh/kernel/dist/assets/eslint/missing-performance.config.mjs',
        category: 'performance',
      },
    });

    expect(result.status).toBe('unavailable');
    expect(result.error).toContain('不存在');
    // 仅 --version 探测被调用，未对缺失的 config 发起真实扫描
    const scanCallArgs = execFileMock.mock.calls
      .map((c) => c[1] as string[])
      .filter((a) => a.includes('--config'));
    expect(scanCallArgs).toHaveLength(0);
  });

  it('config 文件存在时不触发缺失分支，正常调用 ESLint', async () => {
    const confDir = path.join(tempDir, 'assets');
    mkdirSync(confDir, { recursive: true });
    const confFile = path.join(confDir, 'eslint-performance.config.mjs');
    writeFileSync(confFile, 'export default [];');

    mockSuccess('[]');
    const adapter = new ESLintAdapter(tempDir);
    const result = await adapter.scan({
      projectPath: tempDir,
      config: {
        config: path.relative(tempDir, confFile),
        category: 'performance',
      },
    });

    expect(execFileMock).toHaveBeenCalled();
    expect(result.status).toBe('available');
  });
});
