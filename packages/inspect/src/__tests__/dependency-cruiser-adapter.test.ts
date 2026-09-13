import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
