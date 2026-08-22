import { describe, it, expect, vi } from 'vitest';
import { AdapterRegistry } from '../../adapter-registry';
import { GuardTrivyAdapter } from '../guard-trivy-adapter';
import { GuardEngine } from '../../engine';
import type { CheckConfig } from '../../types';

// 桩掉进程执行边界：GuardTrivyAdapter 默认经 PATH 解析 trivy 二进制，
// 这里让 execFile 返回罐化 JSON，验证 注册表路径 → run → normalize → 聚合 全链路。
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const TRIVY_JSON = JSON.stringify({
  SchemaVersion: 2,
  ArtifactName: 'demo-project',
  Results: [
    {
      Target: 'package.json',
      Class: 'lang-pkgs',
      Type: 'npm',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-0001',
          PkgName: 'left-pad',
          InstalledVersion: '1.0.0',
          FixedVersion: '1.3.0',
          Severity: 'CRITICAL',
          Title: 'Critical vulnerability',
          Description: 'Demo critical vulnerability',
        },
      ],
      Misconfigurations: [
        {
          ID: 'AVD-DS-0002',
          Severity: 'HIGH',
          Title: 'Insecure configuration',
          Description: 'Demo misconfiguration',
        },
      ],
    },
  ],
});

function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    checkId: 'TRVY-001',
    adapter: 'trivy',
    enabled: true,
    mode: ['guard'],
    category: 'security',
    severity: 'error',
    blocking: true,
    description: 'Trivy security check',
    ...overrides,
  };
}

describe('GuardTrivyAdapter — registry path integration', () => {
  it('should flow a canned trivy scan through registry lookup, run, normalize and aggregation', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _options: unknown,
        cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
      ) => {
        if (args[0] === '--version') {
          cb(null, { stdout: 'Version: 0.55.0\n', stderr: '' });
          return;
        }
        cb(null, { stdout: TRIVY_JSON, stderr: '' });
      },
    );

    // 与 GuardEngine.runChecks 相同的注册表路径：registerAdapter → registry.get(adapter)
    const registry = new AdapterRegistry();
    registry.register('trivy', new GuardTrivyAdapter());
    expect(registry.list()).toContain('trivy');

    const adapter = registry.get('trivy');
    const raw = (await Promise.resolve(adapter.run({ projectPath: '/tmp/demo-project' }, makeCheck()))) as {
      status: string;
      summary: { total: number; critical: number; high: number };
    };

    // 罐化扫描结果：1 CRITICAL 漏洞 + 1 HIGH 配置问题
    expect(raw.status).toBe('failed');
    expect(raw.summary.total).toBe(2);
    expect(raw.summary.critical).toBe(1);
    expect(raw.summary.high).toBe(1);

    const result = adapter.normalize(raw, {}, makeCheck());
    expect(result.checkId).toBe('TRVY-001');
    expect(result.adapter).toBe('trivy');
    expect(result.status).toBe('failed');
    expect(result.severity).toBe('error'); // failed → check.severity
    expect(result.blocking).toBe(true);

    // 结果流入真实引擎聚合统计
    const engine = new GuardEngine('/tmp/demo-project');
    const report = engine.aggregateReport([result], { mode: 'guard', target: '/tmp/demo-project' });
    expect(report.contractVersion).toBe('p0.v1');
    expect(report.summary.total).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.blocking).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('should resolve the trivy binary via PATH using the default constructor', async () => {
    execFileMock.mockClear();
    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _options: unknown,
        cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
      ) => {
        if (args[0] === '--version') {
          cb(null, { stdout: 'Version: 0.55.0\n', stderr: '' });
          return;
        }
        cb(null, { stdout: TRIVY_JSON, stderr: '' });
      },
    );

    const registry = new AdapterRegistry();
    registry.register('trivy', new GuardTrivyAdapter());
    const adapter = registry.get('trivy');
    await Promise.resolve(adapter.run({}, makeCheck()));

    // isAvailable(--version) + 漏洞扫描(fs) + 配置扫描(fs --scanners config)，全部走默认二进制名
    expect(execFileMock).toHaveBeenCalledTimes(3);
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).toBe('trivy');
    }
  });
});
