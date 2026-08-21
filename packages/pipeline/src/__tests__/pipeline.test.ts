import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { PipelineRunner } from '../pipeline-runner';
import { GuardSensitiveInfoAdapter } from '@zh/guard';
import { PluginLoader } from '@zh/kernel';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCAN_TARGET = path.resolve(__dirname, '..');

const ESLINT_LINT = /eslint|lint/i;
const TARGET_ENGINE = /^(guard|inspect)$/;

describe('PipelineRunner — 端到端集成测试', () => {
  let runner: PipelineRunner;
  let scanRunner: PipelineRunner;

  beforeAll(async () => {
    runner = new PipelineRunner(REPO_ROOT);
    scanRunner = new PipelineRunner(SCAN_TARGET);

    const count = await runner.loadSopRules();
    expect(count).toBeGreaterThan(0);
    await scanRunner.loadSopRules();
  });

  afterAll(async () => {
    await runner.destroy();
    await scanRunner.destroy();
  });

  it('1. 加载 SOP 规则', () => {
    const stats = runner.sopRegistry.getStats();
    expect(stats.totalRules).toBeGreaterThan(0);
    expect(stats.byDomain.guard).toBeGreaterThan(0);
    expect(stats.byDomain.inspect).toBeGreaterThan(0);
    expect(stats.byDomain.security).toBeGreaterThan(0);
    expect(stats.byStatus.active).toBeGreaterThan(0);
  });

  it('2. SOP 规则查询', () => {
    const guardRules = runner.sopRegistry.getByDomain('guard');
    expect(guardRules.length).toBeGreaterThan(0);
    const eslintRule = guardRules.find((r) => r.name?.toLowerCase().includes('eslint'));
    expect(eslintRule).toBeDefined();
    expect(eslintRule!.status).toBe('active');
  });

  it('3. GuardEngine LINT-001', async () => {
    const report = await runner.guardEngine.run({
      mode: 'guard', checks: ['LINT-001'], format: 'json', target: REPO_ROOT,
    });
    expect(report.contractVersion).toBe('p0.v1');
    expect(report.summary.total).toBeGreaterThanOrEqual(1);
    expect(report.summary.total).toBeLessThanOrEqual(3);
    expect(report.results.length).toBe(report.summary.total);
    const lintRelated = report.results.some(
      (r) =>
        r.checkId === 'LINT-001' ||
        ESLINT_LINT.test(r.checkId) ||
        ESLINT_LINT.test(r.message),
    );
    expect(lintRelated).toBe(true);
    expect(['passed', 'failed', 'error', 'warning']).toContain(report.results[0].status);
  });

  it('4. GuardSensitiveInfoAdapter', () => {
    const adapter = new GuardSensitiveInfoAdapter();
    const raw = adapter.run({ repoRoot: REPO_ROOT }, {
      checkId: 'SEC-002', adapter: 'sensitive-info', enabled: true,
      mode: ['guard'], category: 'security', severity: 'error',
      blocking: true, description: '敏感信息检查',
    });
    expect(raw).toBeDefined();
    expect(Array.isArray(raw.findings)).toBe(true);
    const result = adapter.normalize(raw, {}, {
      checkId: 'SEC-002', adapter: 'sensitive-info', enabled: true,
      mode: ['guard'], category: 'security', severity: 'error',
      blocking: true, description: '敏感信息检查',
    });
    expect(['passed', 'failed', 'error']).toContain(result.status);
    expect(result.checkId).toBe('SEC-002');
  });

  it('5. InspectEngine SCAN_TARGET', async () => {
    const report = await scanRunner.inspectEngine.runScan(SCAN_TARGET, 'full');
    expect(report.projectId).toBe(SCAN_TARGET);
    expect(report.scanType).toBe('full');
    expect(report.score.overall).toBeGreaterThanOrEqual(0);
    expect(['A', 'B', 'C', 'D']).toContain(report.score.grade);
  });

  it('6. 完整流水线', async () => {
    const p = await scanRunner.runFullPipeline({ checks: ['LINT-001'], dryRun: true });
    expect(p.stage).toBe('complete');
    expect(p.passed).toBe(true);
    expect(p.guard).not.toBeNull();
    expect(p.inspect).not.toBeNull();
    expect(p.profile).not.toBeNull();
    expect(p.profile!.projectPath).toBe(SCAN_TARGET);
    expect(p.security).not.toBeNull();
    expect(p.security!.securityScore).toBeGreaterThanOrEqual(0);
    expect(p.score).not.toBeNull();
    expect(['A', 'B', 'C', 'D']).toContain(p.score!.grade);
  });

  it('7. 插件管理器', async () => {
    const loader = new PluginLoader();
    await loader.load({ name: 'tp', version: '1.0.0', init: async () => {}, destroy: async () => {} });
    expect(loader.get('tp')).toBeDefined();
    expect(loader.list()).toHaveLength(1);
    await loader.unload('tp');
    expect(loader.get('tp')).toBeUndefined();
  });

  it('8. SOP Guard', async () => {
    const report = await scanRunner.runSopGuard({ dryRun: true });
    // dryRun（只报告不阻断）下 ok 为 null
    expect(report.ok).not.toBe(false);
    expect(Array.isArray(report.evaluations)).toBe(true);
    for (const ev of report.evaluations) {
      expect(['passed', 'failed', 'error', 'skipped']).toContain(ev.status);
    }
  });

  it('9. SOP Inspect', async () => {
    const report = await scanRunner.runSopInspect({ dryRun: true });
    expect(Array.isArray(report.evaluations)).toBe(true);
    for (const ev of report.evaluations) {
      expect(ev.targetEngine).toMatch(TARGET_ENGINE);
    }
  });

  it('10. SOP 全流水线', async () => {
    const p = await scanRunner.runSopDrivenPipeline({
      guardContext: { dryRun: true }, inspectContext: { dryRun: true },
    });
    expect(p.stage).toBe('complete');
    expect(p.passed).toBe(true);
  });
});
