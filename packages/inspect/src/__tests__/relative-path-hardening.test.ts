import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { SemgrepAdapter } from '../adapters/semgrep-adapter';
import { GitleaksAdapter } from '../adapters/gitleaks-adapter';

const execFileMock = vi.mocked(execFile);

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

function tempProject(withSrc: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rel-path-'));
  if (withSrc) mkdirSync(path.join(dir, 'src'));
  return dir;
}

/** 相对路径：从 process.cwd() 到项目目录（模拟 CLI --dir ./scripts/fixtures/sample-repo 场景） */
function relativeToCwd(abs: string): string {
  return path.relative(process.cwd(), abs);
}

/** 定位真正的 scan 调用（args 首元素为 'scan'），跳过命令解析的 --version 探测 */
function scanArgs(): string[] {
  const call = execFileMock.mock.calls.find((c) => (c[1] as string[]).includes('scan'));
  return (call?.[1] as string[]) ?? [];
}

afterEach(() => {
  execFileMock.mockReset();
});

describe('相对 projectPath 归一化为绝对路径（外部工具扫描回归）', () => {
  it('Given 相对 projectPath，When SemgrepAdapter.scan 执行，Then --config 与目标目录均为绝对路径', async () => {
    const project = tempProject(true);
    writeFileSync(path.join(project, 'redos.yml'), 'rules: []');
    const relProject = relativeToCwd(project);
    try {
      mockSuccess(JSON.stringify({ version: '1.172.0', results: [], errors: [] }), '');

      await new SemgrepAdapter().scan({
        projectPath: relProject,
        projectId: relProject,
        config: { enabled: true, config: 'redos.yml' },
      });

      const args = scanArgs();
      const configIndex = args.indexOf('--config');
      const configArg = args[configIndex + 1];
      const targetArg = args.at(-1)!;
      expect(path.isAbsolute(configArg)).toBe(true);
      expect(path.isAbsolute(targetArg)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('Given 相对 projectPath，When GitleaksAdapter.scan 执行，Then --source 参数与 cwd 均为绝对路径', async () => {
    const project = tempProject(false);
    const relProject = relativeToCwd(project);
    try {
      mockSuccess(JSON.stringify([]), '');

      await new GitleaksAdapter().scan({
        projectPath: relProject,
        projectId: relProject,
        config: { enabled: true },
      });

      const call = execFileMock.mock.calls.find((c) => (c[1] as string[]).includes('detect'));
      const args = call?.[1] as string[];
      const sourceIndex = args.indexOf('--source');
      const sourceArg = args[sourceIndex + 1];
      const cwd = (call?.[2] as { cwd?: string })?.cwd;
      expect(path.isAbsolute(sourceArg)).toBe(true);
      expect(path.isAbsolute(cwd ?? '')).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});