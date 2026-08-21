import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { SemgrepAdapter } from '../adapters/semgrep-adapter';

const execFileMock = vi.mocked(execFile);
const adapter = new SemgrepAdapter();

/** 本机 semgrep-core（OCaml 运行时）每次启动都会打印的无害告警，非扫描失败原因 */
const OCAML_NOISE_STDERR = [
  'Failed to register segfault signal handler! exit_code: 52625665',
  'Failed to register unwind handler for some critical signals, such as SIGSEGV. If we segfault you are on your own and you will receive no backtraces',
].join('\n');

interface MockExecError {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

// 模拟 node:child_process.execFile（回调风格，promisify 后单值解析为 { stdout, stderr }）
function mockSuccess(stdout: string, stderr = ''): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr });
  }) as never);
}

function mockFailure(err: MockExecError): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error) => void,
  ) => {
    cb(Object.assign(new Error(err.message ?? 'Command failed'), err) as Error);
  }) as never);
}

function emptyScanOutput(): string {
  return JSON.stringify({ version: '1.172.0', results: [], errors: [] });
}

function tempProject(withSrc: boolean, withPackages = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'semgrep-adapter-'));
  if (withSrc) mkdirSync(path.join(dir, 'src'));
  if (withPackages) mkdirSync(path.join(dir, 'packages'));
  return dir;
}

/** 容器根项目：含一个嵌套代码仓库（有 package.json + packages/） */
function tempContainerProject(): { root: string; nested: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'semgrep-container-'));
  const nested = path.join(root, 'nested-app');
  mkdirSync(path.join(nested, 'packages'), { recursive: true });
  writeFileSync(path.join(nested, 'package.json'), '{"name":"nested-app"}');
  return { root, nested };
}

function lastTargetArg(): string {
  const args = execFileMock.mock.calls[0][1] as string[];
  return args.at(-1)!;
}

afterEach(() => {
  execFileMock.mockReset();
});

describe('SemgrepAdapter', () => {
  it('扫描失败时优先报告 semgrep JSON errors 中的真实错误，而非 OCaml 运行时噪音', async () => {
    const project = tempProject(false);
    try {
      mockFailure({
        code: 2,
        stdout: JSON.stringify({
          version: '1.172.0',
          results: [],
          errors: [{ code: 2, level: 'error', type: 'SemgrepError', message: 'Invalid scanning root: src' }],
        }),
        stderr: OCAML_NOISE_STDERR,
        message: 'Command failed: semgrep scan',
      });

      const result = await adapter.scan({ projectPath: project, projectId: project });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Invalid scanning root: src');
      expect(result.error).not.toContain('Failed to register');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('无 JSON 输出时剔除 stderr 中的 OCaml 运行时噪音后兜底', async () => {
    const project = tempProject(true);
    try {
      mockFailure({ code: 1, stdout: '', stderr: OCAML_NOISE_STDERR, message: 'Command failed: semgrep scan' });

      const result = await adapter.scan({ projectPath: project, projectId: project });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Command failed: semgrep scan');
      expect(result.error).not.toContain('Failed to register');
      expect(result.error).not.toContain('unwind handler');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('扫描超时返回明确错误信息', async () => {
    const project = tempProject(true);
    try {
      mockFailure({ code: 'ETIMEDOUT', stdout: '', stderr: '', message: 'ETIMEDOUT' });

      const result = await adapter.scan({ projectPath: project, projectId: project });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Semgrep 扫描超时');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('semgrep 存在 findings（退出码 1）时正常映射问题', async () => {
    const project = tempProject(true);
    try {
      mockFailure({
        code: 1,
        stdout: JSON.stringify({
          version: '1.172.0',
          results: [{
            check_id: 'detect-redos',
            path: 'src/a.js',
            start: { line: 2, col: 1 },
            extra: { severity: 'WARNING', message: 'ReDoS risk' },
          }],
          errors: [],
        }),
        stderr: OCAML_NOISE_STDERR,
        message: 'Command failed',
      });

      const result = await adapter.scan({
        projectPath: project,
        projectId: project,
        config: { enabled: true, category: 'performance' },
      });

      expect(result.status).toBe('available');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].ruleId).toBe('detect-redos');
      expect(result.issues[0].category).toBe('performance');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('目标目录解析：src → packages → 项目根 依次回退', async () => {
    const withSrc = tempProject(true);
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: withSrc, projectId: withSrc, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(path.join(withSrc, 'src'));
    } finally {
      rmSync(withSrc, { recursive: true, force: true });
    }

    const withPackages = tempProject(false, true);
    try {
      execFileMock.mockReset();
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: withPackages, projectId: withPackages, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(path.join(withPackages, 'packages'));
    } finally {
      rmSync(withPackages, { recursive: true, force: true });
    }

    const bare = tempProject(false);
    try {
      execFileMock.mockReset();
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: bare, projectId: bare, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('容器根项目：下探到嵌套代码仓库的 packages 目录，避免全量扫描', async () => {
    const container = tempContainerProject();
    const nestedPkg = path.join(container.nested, 'packages');
    try {
      mockSuccess(emptyScanOutput(), OCAML_NOISE_STDERR);
      await adapter.scan({ projectPath: container.root, projectId: container.root, config: { enabled: true, config: 'redos.yml' } });
      expect(lastTargetArg()).toBe(nestedPkg);
    } finally {
      rmSync(container.root, { recursive: true, force: true });
    }
  });
});
