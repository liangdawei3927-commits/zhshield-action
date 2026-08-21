import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GuardEngine } from '../engine';
import { ConfigLoader } from '../config-loader';
import { AdapterRegistry } from '../adapter-registry';
import { ResultNormalizer } from '../result-normalizer';
import { GuardESLintCheckAdapter } from '../adapters/eslint-check-adapter';
import { resolveEslintTargetDir } from '../adapters/eslint-check-adapter';
import { GuardSensitiveInfoAdapter } from '../adapters/sensitive-info-adapter';
import { ArchitectureBoundaryAdapter } from '../adapters/architecture-boundary-adapter';
import { SecurityScanAdapter } from '../adapters/security-scan-adapter';
import type { CheckConfig, Adapter } from '../types';

// ─── Helper ───────────────────────────────────────────────

function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    checkId: 'test-check',
    adapter: 'test-adapter',
    enabled: true,
    mode: ['guard'],
    category: 'security',
    severity: 'error',
    blocking: true,
    description: 'Test check',
    ...overrides,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
}

// ─── AdapterRegistry ──────────────────────────────────────

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('should register and retrieve an adapter', () => {
    const mockAdapter: Adapter = { run: vi.fn(), normalize: vi.fn() };
    registry.register('mock', mockAdapter);
    expect(registry.get('mock')).toBe(mockAdapter);
  });

  it('should throw for non-existent adapter', () => {
    expect(() => registry.get('nonexistent')).toThrow('adapter not found: nonexistent');
  });

  it('should report has() correctly', () => {
    expect(registry.has('x')).toBe(false);
    registry.register('x', { run: vi.fn(), normalize: vi.fn() });
    expect(registry.has('x')).toBe(true);
  });

  it('should list registered adapters', () => {
    registry.register('a', { run: vi.fn(), normalize: vi.fn() });
    registry.register('b', { run: vi.fn(), normalize: vi.fn() });
    expect(registry.list()).toEqual(['a', 'b']);
  });
});

// ─── ResultNormalizer ─────────────────────────────────────

describe('ResultNormalizer', () => {
  it('should create error result from exception', () => {
    const normalizer = new ResultNormalizer();
    const check = makeCheck();
    const error = new Error('something broke');
    const result = normalizer.fromException(check, error);

    expect(result.status).toBe('error');
    expect(result.message).toBe('something broke');
    expect(result.checkId).toBe('test-check');
  });

  it('should handle non-Error exceptions', () => {
    const normalizer = new ResultNormalizer();
    const check = makeCheck();
    const result = normalizer.fromException(check, 'string error');

    expect(result.status).toBe('error');
    expect(result.message).toBe('string error');
  });

  it('should normalize a result with given status', () => {
    const normalizer = new ResultNormalizer();
    const check = makeCheck({ severity: 'warning' });
    const result = normalizer.normalize('passed', 'All good', check, { extra: true });

    expect(result.status).toBe('passed');
    expect(result.message).toBe('All good');
    expect(result.details).toEqual({ extra: true });
  });
});

// ─── ConfigLoader ─────────────────────────────────────────

describe('ConfigLoader', () => {
  it('should return empty array for non-existent config dir', () => {
    const loader = new ConfigLoader('/nonexistent/path');
    expect(loader.loadChecks()).toEqual([]);
  });

  it('should load checks from valid config dir', () => {
    const dir = makeTempDir();
    const checks: CheckConfig[] = [makeCheck({ checkId: 'c1' })];
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(checks));

    const loader = new ConfigLoader(dir);
    const loaded = loader.loadChecks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].checkId).toBe('c1');

    fs.rmSync(dir, { recursive: true });
  });

  it('should return empty object for non-existent severities', () => {
    const loader = new ConfigLoader('/nonexistent');
    expect(loader.loadSeverities()).toEqual({});
  });
});

// ─── GuardEngine ──────────────────────────────────────────

describe('GuardEngine', () => {
  it('should filter checks by mode', () => {
    const engine = new GuardEngine('/tmp');
    const checks: CheckConfig[] = [
      makeCheck({ checkId: 'c1', mode: ['guard'] }),
      makeCheck({ checkId: 'c2', mode: ['inspection'] }),
      makeCheck({ checkId: 'c3', mode: ['guard', 'inspection'] }),
    ];

    const filtered = engine.filterChecks(checks, { mode: 'guard' });
    expect(filtered.map(c => c.checkId)).toEqual(['c1', 'c3']);
  });

  it('should filter out disabled checks', () => {
    const engine = new GuardEngine('/tmp');
    const checks: CheckConfig[] = [
      makeCheck({ checkId: 'c1', enabled: true }),
      makeCheck({ checkId: 'c2', enabled: false }),
    ];

    const filtered = engine.filterChecks(checks, { mode: 'guard' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].checkId).toBe('c1');
  });

  it('should filter by profile', () => {
    const engine = new GuardEngine('/tmp');
    const checks: CheckConfig[] = [
      makeCheck({ checkId: 'c1', category: 'security' }),
      makeCheck({ checkId: 'c2', category: 'quality' }),
    ];

    const filtered = engine.filterChecks(checks, { mode: 'guard', profile: 'security' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].checkId).toBe('c1');
  });

  it('should filter by specific check IDs', () => {
    const engine = new GuardEngine('/tmp');
    const checks: CheckConfig[] = [
      makeCheck({ checkId: 'c1' }),
      makeCheck({ checkId: 'c2' }),
      makeCheck({ checkId: 'c3' }),
    ];

    const filtered = engine.filterChecks(checks, { mode: 'guard', checks: ['c1', 'c3'] });
    expect(filtered.map(c => c.checkId)).toEqual(['c1', 'c3']);
  });

  it('should aggregate report correctly', () => {
    const engine = new GuardEngine('/tmp');
    const results = [
      { checkId: 'c1', adapter: 'a', status: 'passed' as const, severity: 'info' as const, blocking: false, message: 'ok' },
      { checkId: 'c2', adapter: 'a', status: 'failed' as const, severity: 'error' as const, blocking: true, message: 'fail' },
      { checkId: 'c3', adapter: 'a', status: 'error' as const, severity: 'error' as const, blocking: true, message: 'err' },
      { checkId: 'c4', adapter: 'a', status: 'warning' as const, severity: 'warning' as const, blocking: false, message: 'warn' },
    ];

    const report = engine.aggregateReport(results, { mode: 'guard' });
    expect(report.ok).toBe(false);
    expect(report.summary.total).toBe(4);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.warnings).toBe(1);
    expect(report.summary.blocking).toBe(2);
  });

  it('should report ok=true when no failures', () => {
    const engine = new GuardEngine('/tmp');
    const results = [
      { checkId: 'c1', adapter: 'a', status: 'passed' as const, severity: 'info' as const, blocking: false, message: 'ok' },
    ];

    const report = engine.aggregateReport(results, { mode: 'guard' });
    expect(report.ok).toBe(true);
  });

  it('should return null ok when dryRun', () => {
    const engine = new GuardEngine('/tmp');
    const results = [
      { checkId: 'c1', adapter: 'a', status: 'failed' as const, severity: 'error' as const, blocking: true, message: 'fail' },
    ];

    const report = engine.aggregateReport(results, { mode: 'guard', dryRun: true });
    expect(report.ok).toBeNull();
    expect(report.dryRun).toBe(true);
  });

  it('should run with mock adapter via traditional mode', async () => {
    const dir = makeTempDir();
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const checks: CheckConfig[] = [makeCheck({ checkId: 'mock-check', adapter: 'mock' })];
    fs.writeFileSync(path.join(configDir, 'checks.json'), JSON.stringify(checks));

    const mockAdapter: Adapter = {
      run: vi.fn().mockReturnValue({ passed: true }),
      normalize: vi.fn().mockReturnValue({
        checkId: 'mock-check',
        adapter: 'mock',
        status: 'passed',
        severity: 'info',
        blocking: false,
        message: 'mock passed',
      }),
    };

    const engine = new GuardEngine(dir, configDir);
    engine.registerAdapter('mock', mockAdapter);

    const report = await engine.run({ mode: 'guard' });
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(mockAdapter.run).toHaveBeenCalled();
    expect(mockAdapter.normalize).toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true });
  });

  it('should handle adapter error gracefully', async () => {
    const dir = makeTempDir();
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const checks: CheckConfig[] = [makeCheck({ checkId: 'err-check', adapter: 'bad' })];
    fs.writeFileSync(path.join(configDir, 'checks.json'), JSON.stringify(checks));

    const badAdapter: Adapter = {
      run: vi.fn().mockRejectedValue(new Error('adapter crashed')),
      normalize: vi.fn(),
    };

    const engine = new GuardEngine(dir, configDir);
    engine.registerAdapter('bad', badAdapter);

    const report = await engine.run({ mode: 'guard' });
    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe('error');
    expect(report.results[0].message).toBe('adapter crashed');

    fs.rmSync(dir, { recursive: true });
  });
});

// ─── Sensitive Info Adapter normalize ─────────────────────

describe('GuardSensitiveInfoAdapter', () => {
  it('should return passed when no findings', () => {
    const adapter = new GuardSensitiveInfoAdapter();
    const check = makeCheck({ checkId: 'si-check' });
    const result = adapter.normalize({ findings: [] }, {}, check);
    expect(result.status).toBe('passed');
  });

  it('should return failed when findings exist', () => {
    const adapter = new GuardSensitiveInfoAdapter();
    const check = makeCheck({ checkId: 'si-check' });
    const result = adapter.normalize(
      { findings: [{ file: 'src/config.ts', line: 5, pattern: 'API Key', match: 'api_key=xxx' }] },
      {},
      check,
    );
    expect(result.status).toBe('failed');
    expect(result.details.count).toBe(1);
  });

  it('should return error on scan failure', () => {
    const adapter = new GuardSensitiveInfoAdapter();
    const check = makeCheck({ checkId: 'si-check' });
    const result = adapter.normalize({ findings: [], error: 'permission denied' }, {}, check);
    expect(result.status).toBe('error');
  });
});

// ─── Architecture Boundary Adapter normalize ──────────────

describe('ArchitectureBoundaryAdapter', () => {
  it('should return passed when no violations', () => {
    const adapter = new ArchitectureBoundaryAdapter();
    const check = makeCheck({ checkId: 'ab-check' });
    const result = adapter.normalize({ violations: [] }, {}, check);
    expect(result.status).toBe('passed');
  });

  it('should return failed when violations exist', () => {
    const adapter = new ArchitectureBoundaryAdapter();
    const check = makeCheck({ checkId: 'ab-check' });
    const result = adapter.normalize(
      { violations: [{ file: 'src/web/page.ts', line: 1, fromLayer: 'presentation', toLayer: 'domain', importPath: '../../domain' }] },
      {},
      check,
    );
    expect(result.status).toBe('failed');
    expect(result.details.count).toBe(1);
  });

  it('should return error on scan failure', () => {
    const adapter = new ArchitectureBoundaryAdapter();
    const check = makeCheck({ checkId: 'ab-check' });
    const result = adapter.normalize({ violations: [], error: 'disk error' }, {}, check);
    expect(result.status).toBe('error');
  });
});

// ─── Security Scan Adapter normalize ──────────────────────

describe('SecurityScanAdapter', () => {
  it('should return passed when no findings', () => {
    const adapter = new SecurityScanAdapter();
    const check = makeCheck({ checkId: 'ss-check' });
    const result = adapter.normalize({ findings: [] }, {}, check);
    expect(result.status).toBe('passed');
  });

  it('should return failed when high-severity findings exist', () => {
    const adapter = new SecurityScanAdapter();
    const check = makeCheck({ checkId: 'ss-check' });
    const result = adapter.normalize(
      { findings: [
        { file: 'src/db.ts', line: 10, type: 'sql-injection', severity: 'high', message: 'SQL injection' },
      ]},
      {},
      check,
    );
    expect(result.status).toBe('failed');
    expect(result.details.highCount).toBe(1);
  });

  it('should return warning for medium-severity only', () => {
    const adapter = new SecurityScanAdapter();
    const check = makeCheck({ checkId: 'ss-check' });
    const result = adapter.normalize(
      { findings: [
        { file: 'src/app.ts', line: 5, type: 'debugger', severity: 'medium', message: 'debugger found' },
      ]},
      {},
      check,
    );
    expect(result.status).toBe('warning');
  });

  it('should return error on scan failure', () => {
    const adapter = new SecurityScanAdapter();
    const check = makeCheck({ checkId: 'ss-check' });
    const result = adapter.normalize({ findings: [], error: 'timeout' }, {}, check);
    expect(result.status).toBe('error');
  });
});

// ─── ESLint Adapter normalize ─────────────────────────────

describe('GuardESLintCheckAdapter normalize', () => {
  it('should return passed when no files', () => {
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck({ checkId: 'lint-check' });
    const result = adapter.normalize({ files: [] }, {}, check);
    expect(result.status).toBe('passed');
  });

  it('should return failed when errors found', () => {
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck({ checkId: 'lint-check' });
    const raw = {
      files: [{
        filePath: '/src/app.ts',
        messages: [{ ruleId: 'no-unused-vars', message: 'x unused', line: 1, column: 1, severity: 2 }],
      }],
    };
    const result = adapter.normalize(raw, {}, check);
    expect(result.status).toBe('failed');
    expect(result.details.totalErrors).toBe(1);
  });

  it('should return warning for warnings only', () => {
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck({ checkId: 'lint-check', severity: 'warning' });
    const raw = {
      files: [{
        filePath: '/src/app.ts',
        messages: [{ ruleId: 'no-console', message: 'console.log', line: 1, column: 1, severity: 1 }],
      }],
    };
    const result = adapter.normalize(raw, {}, check);
    expect(result.status).toBe('warning');
    expect(result.details.totalWarnings).toBe(1);
  });

  it('should return error on execution error', () => {
    const adapter = new GuardESLintCheckAdapter();
    const check = makeCheck({ checkId: 'lint-check' });
    const result = adapter.normalize({ files: [], error: 'ESLint not installed' }, {}, check);
    expect(result.status).toBe('error');
    expect(result.message).toContain('ESLint');
  });
});

// ─── ESLint Adapter targetDir 探测 ────────────────────────

describe('resolveEslintTargetDir', () => {
  it('有 src 目录时优先用 src', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'src'));
    expect(resolveEslintTargetDir(dir)).toBe(path.join(dir, 'src'));
  });

  it('无 src 但为 monorepo（有 packages）时用 packages', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'packages'));
    expect(resolveEslintTargetDir(dir)).toBe(path.join(dir, 'packages'));
  });

  it('src 与 packages 均不存在时回退到项目根', () => {
    const dir = makeTempDir();
    expect(resolveEslintTargetDir(dir)).toBe(dir);
  });

  it('嵌套仓库：子目录含 eslint 配置时指向该子目录', () => {
    const dir = makeTempDir();
    const repo = path.join(dir, 'zhiyan-codeshield');
    fs.mkdirSync(path.join(repo, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default []');
    expect(resolveEslintTargetDir(dir)).toBe(repo);
  });

  it('项目根本身含 eslint 配置时用项目根', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), 'export default []');
    expect(resolveEslintTargetDir(dir)).toBe(dir);
  });
});
