import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { DependencyCruiserAdapter } from '../adapters/dependency-cruiser-adapter';

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

/** depcruiser v16+ 真实 JSON 输出：violation.from/to 为字符串路径（非对象） */
function realCycleOutput(): string {
  return JSON.stringify({
    modules: [],
    summary: {
      violations: [
        {
          type: 'cycle',
          from: 'packages/desktop/electron/ipc/projects.ts',
          to: 'packages/desktop/electron/profile-drift.ts',
          unresolvedTo: '../profile-drift',
          dependencyTypes: ['local', 'dynamic-import'],
          rule: { severity: 'error', name: 'no-circular' },
          cycle: [{ name: 'a.ts' }, { name: 'b.ts' }],
        },
      ],
    },
  });
}

describe('DependencyCruiserAdapter', () => {
  let adapter: DependencyCruiserAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DependencyCruiserAdapter();
  });

  it('maps string from/to paths into issue file/message/fingerprint', async () => {
    mockSuccess(realCycleOutput());
    const result = await adapter.scan({
      projectPath: '/work',
      config: { config: '.dependency-cruiser.cjs' },
    } as never);

    expect(result.status).toBe('available');
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.ruleId).toBe('no-circular');
    expect(issue.severity).toBe('error');
    expect(issue.file).toBe('packages/desktop/electron/ipc/projects.ts');
    expect(issue.line).toBe(0);
    expect(issue.message).toContain('projects.ts');
    expect(issue.message).toContain('profile-drift.ts');
    expect(issue.fingerprint).toBe(
      'dep-cruiser:no-circular:packages/desktop/electron/ipc/projects.ts:packages/desktop/electron/profile-drift.ts',
    );
  });

  it('returns error when modules=0 but target dir contains cruisable source files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruiser-guard-'));
    fs.writeFileSync(
      path.join(tmpDir, 'circular-a.ts'),
      'import { b } from "./circular-b"; export const a = b;',
    );

    mockSuccess(JSON.stringify({ modules: [], summary: { violations: [] } }));

    const result = await adapter.scan({
      projectPath: tmpDir,
      config: { config: '.dependency-cruiser.cjs' },
    } as never);

    expect(result.status).toBe('error');
    expect(result.error).toContain('dep-cruiser 未扫描到任何模块');
    expect(result.issues).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns available when modules=0 and target dir has no source files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruiser-empty-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'no code here');

    mockSuccess(JSON.stringify({ modules: [], summary: { violations: [] } }));

    const result = await adapter.scan({
      projectPath: tmpDir,
      config: { config: '.dependency-cruiser.cjs' },
    } as never);

    expect(result.status).toBe('available');
    expect(result.issues).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true });
  });

  // P1（复查5）：只说"疑似版本问题"用户无从下手 —— 必须报出实际使用的命令来源与版本，
  // 并给出可执行指引（实证：全局 18.1.1 → modules=0；本地 18.2.0 → modules=18/violations=1）
  it('modules=0 的报错需带出实际使用的工具来源与修复指引', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruiser-hint-'));
    fs.writeFileSync(path.join(tmpDir, 'circular-a.ts'), 'export const a = 1;');

    mockSuccess(JSON.stringify({ modules: [], summary: { violations: [] } }));

    const result = await adapter.scan({
      projectPath: tmpDir,
      config: { config: '.dependency-cruiser.cjs' },
    } as never);

    expect(result.status).toBe('error');
    expect(result.error).toContain('本次实际使用');
    expect(result.error).toContain('来源：');
    // 真根因是缺 typescript（非版本），指引必须指向可执行动作
    expect(result.error).toContain('typescript');
    expect(result.error).toContain('npm i -D dependency-cruiser typescript');
    // 不得再指引一条并不存在的 CLI 子命令（2026-09-17 更正）
    expect(result.error).not.toContain('zhshield tools install');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
