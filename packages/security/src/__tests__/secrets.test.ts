import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  hashSecret,
  maskSecret,
  mapRuleToType,
  classifySeverity,
  sortFindings,
  parseRemoteHost,
  isPublicRemoteUrl,
  SecretLifecycleManager,
  InMemorySecretStore,
} from '../index';
import type { CommandRunner, SecretFinding } from '../secrets/types';

const SHA256_RE = /^[0-9a-f]{64}$/;

describe('secrets 纯函数', () => {
  it('hashSecret 确定性且不落明文', () => {
    expect(hashSecret('sample-secret-value')).toBe(hashSecret('sample-secret-value'));
    expect(hashSecret('sample-secret-value')).toMatch(SHA256_RE);
    expect(hashSecret('sample-secret-value')).not.toContain('sample-secret-value');
  });

  it('maskSecret 仅显示前4+后4', () => {
    expect(maskSecret('abcdefghijkl')).toBe('abcd****ijkl');
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
  });

  it('mapRuleToType 规则映射 + 兜底', () => {
    expect(mapRuleToType('aws-access-token')).toBe('aws-access-key');
    expect(mapRuleToType('github-pat')).toBe('github-token');
    expect(mapRuleToType('private-key')).toBe('private-key');
    expect(mapRuleToType('stripe-access-token')).toBe('stripe-key');
    expect(mapRuleToType('unknown-rule')).toBe('generic-api-key');
  });

  it('classifySeverity 附 C.4 矩阵', () => {
    expect(
      classifySeverity({
        stillReferenced: true,
        type: 'aws-access-key',
        pushedToRemote: true,
        remotePublic: true,
      }),
    ).toBe('critical');
    expect(
      classifySeverity({
        stillReferenced: true,
        type: 'aws-secret-key',
        pushedToRemote: true,
        remotePublic: false,
      }),
    ).toBe('critical');
    expect(
      classifySeverity({
        stillReferenced: true,
        type: 'github-token',
        pushedToRemote: true,
        remotePublic: true,
      }),
    ).toBe('high');
    expect(
      classifySeverity({
        stillReferenced: true,
        type: 'github-token',
        pushedToRemote: false,
        remotePublic: false,
      }),
    ).toBe('medium');
    expect(
      classifySeverity({
        stillReferenced: false,
        type: 'stripe-key',
        pushedToRemote: true,
        remotePublic: true,
      }),
    ).toBe('medium');
    expect(
      classifySeverity({
        stillReferenced: false,
        type: 'generic-api-key',
        pushedToRemote: false,
        remotePublic: false,
      }),
    ).toBe('low');
  });

  it('sortFindings 严重度降序 + 同级仍引用优先', () => {
    const findings: SecretFinding[] = [
      {
        secretId: 'a',
        type: 'generic-api-key',
        displayValue: 'x',
        location: { file: 'f', line: 1, commit: '' },
        introducedAt: '',
        stillReferenced: false,
        pushedToRemote: false,
        remotePublic: false,
        severity: 'low',
        status: 'active',
      },
      {
        secretId: 'b',
        type: 'generic-api-key',
        displayValue: 'x',
        location: { file: 'f', line: 1, commit: '' },
        introducedAt: '',
        stillReferenced: true,
        pushedToRemote: false,
        remotePublic: false,
        severity: 'high',
        status: 'active',
      },
      {
        secretId: 'c',
        type: 'generic-api-key',
        displayValue: 'x',
        location: { file: 'f', line: 1, commit: '' },
        introducedAt: '',
        stillReferenced: true,
        pushedToRemote: false,
        remotePublic: false,
        severity: 'medium',
        status: 'active',
      },
      {
        secretId: 'd',
        type: 'generic-api-key',
        displayValue: 'x',
        location: { file: 'f', line: 1, commit: '' },
        introducedAt: '',
        stillReferenced: false,
        pushedToRemote: false,
        remotePublic: false,
        severity: 'high',
        status: 'active',
      },
    ];
    const sorted = sortFindings(findings);
    expect(sorted.map((f) => f.secretId)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('parseRemoteHost / isPublicRemoteUrl', () => {
    expect(parseRemoteHost('https://github.com/org/repo.git')).toBe('github.com');
    expect(parseRemoteHost('git@github.com:org/repo.git')).toBe('github.com');
    expect(parseRemoteHost('ssh://git@gitlab.com/org/repo.git')).toBe('gitlab.com');
    expect(parseRemoteHost('file:///local/path')).toBe('');
    expect(isPublicRemoteUrl('https://github.com/org/repo.git')).toBe(true);
    expect(isPublicRemoteUrl('git@github.com:org/repo.git')).toBe(true);
    expect(isPublicRemoteUrl('git@git.example.com:org/repo.git')).toBe(false);
    expect(isPublicRemoteUrl('file:///local/path')).toBe(false);
  });
});

describe('SecretLifecycleManager', () => {
  // 测试夹具：为规避 gitleaks 静态扫描误报，样例密钥值用拼接方式构造（运行期仍是完整值）
  const githubPat = 'ghp_' + 'fake-test-token-not-a-real-github-pat';
  const awsAccessKey = 'AKIA' + '-fake-test-key-not-a-real-aws-key';
  const GITLEAKS_WORKSPACE_JSON = JSON.stringify([
    { RuleID: 'github-pat', File: 'src/a.ts', StartLine: 3, Secret: githubPat },
  ]);
  const GITLEAKS_HISTORY_JSON = JSON.stringify([
    {
      RuleID: 'github-pat',
      File: 'src/a.ts',
      StartLine: 3,
      Secret: githubPat,
      Commit: 'abc123',
      Date: '2024-01-01T00:00:00Z',
    },
    {
      RuleID: 'aws-access-token',
      File: 'src/b.ts',
      StartLine: 10,
      Secret: awsAccessKey,
      Commit: 'def456',
      Date: '2023-06-01T00:00:00Z',
    },
  ]);

  function createRunner(_overrides: Partial<CommandRunner> = {}): CommandRunner {
    const run = vi.fn(async (command: string, args: string[], _opts?: { cwd?: string }) => {
      if (command === 'gitleaks') {
        if (args.includes('--log-opts')) return { stdout: GITLEAKS_HISTORY_JSON };
        return { stdout: GITLEAKS_WORKSPACE_JSON };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'HEADHASH\n' };
      if (command === 'git' && args[0] === 'remote')
        return { stdout: 'https://github.com/org/repo.git\n' };
      return { stdout: '' };
    });
    return { run };
  }

  let manager: SecretLifecycleManager;
  let store: InMemorySecretStore;
  let runner: CommandRunner;

  beforeEach(() => {
    store = new InMemorySecretStore();
    runner = createRunner();
    manager = new SecretLifecycleManager(runner, store);
  });

  it('工作区扫描：findings 归一化 + 状态默认 active', async () => {
    const report = await manager.scan('/proj', { history: false });
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0];
    expect(f.type).toBe('github-token');
    expect(f.stillReferenced).toBe(true);
    expect(f.status).toBe('active');
    expect(f.displayValue).toContain('****');
    expect(f.secretId).toMatch(SHA256_RE);
    expect(report.lastScannedCommit).toBe('');
  });

  it('历史扫描：增量断点 = HEAD；history 引入时间与 commit 补齐', async () => {
    const report = await manager.scan('/proj', { history: true });
    expect(report.lastScannedCommit).toBe('HEADHASH');
    const github = report.findings.find((f) => f.type === 'github-token');
    const aws = report.findings.find((f) => f.type === 'aws-access-key');
    expect(github?.location.commit).toBe('abc123');
    expect(github?.introducedAt).toBe('2024-01-01T00:00:00Z');
    expect(github?.stillReferenced).toBe(true);
    expect(aws?.stillReferenced).toBe(false);
    expect(aws?.severity).toBe('medium');
    expect(report.summary.historyFound).toBe(1);
    expect(report.summary.total).toBe(2);
  });

  it('增量扫描：第二次使用 lastScannedCommit..HEAD', async () => {
    await manager.scan('/proj', { history: true });
    const report2 = await manager.scan('/proj', { history: true });
    expect(report2.lastScannedCommit).toBe('HEADHASH');
    const gitCalls = (runner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'gitleaks' && c[1].includes('--log-opts'),
    );
    expect(gitCalls[0][1]).toContain('--all');
    expect(gitCalls[1][1]).toContain('HEADHASH..HEAD');
  });

  it('状态机：markRotating → verifyRotated（值已移除）→ rotated', async () => {
    const report = await manager.scan('/proj', { history: true });
    const id = report.findings[0].secretId;

    await manager.markRotating(id);
    const afterMark = await store.load();
    expect(afterMark.secrets[id].status).toBe('rotating');

    (runner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ stdout: '[]' });
    const verified = await manager.verifyRotated(id);
    expect(verified).toBe(true);
    const afterVerify = await store.load();
    expect(afterVerify.secrets[id].status).toBe('rotated');
  });

  it('verifyRotated：值仍在 → false 且状态不变', async () => {
    const report = await manager.scan('/proj', { history: true });
    const id = report.findings[0].secretId;
    await manager.markRotating(id);

    const verified = await manager.verifyRotated(id);
    expect(verified).toBe(false);
    const state = await store.load();
    expect(state.secrets[id].status).toBe('rotating');
  });

  it('dismiss 记录原因；已 rotated 直接返回 true', async () => {
    const report = await manager.scan('/proj', { history: true });
    const id = report.findings[0].secretId;

    await manager.dismiss(id, '误报：测试夹具');
    const state = await store.load();
    expect(state.secrets[id].status).toBe('dismissed');
    expect(state.secrets[id].reason).toBe('误报：测试夹具');

    (runner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ stdout: '[]' });
    expect(await manager.verifyRotated(id)).toBe(true);
  });

  it('gitleaks 未安装：isGitleaksAvailable false', async () => {
    const badRunner: CommandRunner = {
      run: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    };
    const m = new SecretLifecycleManager(badRunner, new InMemorySecretStore());
    expect(await m.isGitleaksAvailable()).toBe(false);
  });
});
