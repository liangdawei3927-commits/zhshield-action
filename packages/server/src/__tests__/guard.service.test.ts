import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GuardService } from '../guard/guard.service';
import type { GuardEngine } from '@zh/guard';

// 注入桩引擎，避免 runCheck 真实执行整套 guard 检查（其 test-runner 适配器
// 会递归运行整个工作区测试套件，导致用例 60s 超时）。此处仅验证服务层
// 组装与透传逻辑，引擎行为由 @zh/guard 自身测试覆盖。
vi.mock('@zh/guard', () => {
  class FakeEngine {
    registerAdapter = vi.fn();
    run = async (options: { dryRun?: boolean } = {}) => ({
      contractVersion: 'p0.v1',
      mode: 'guard',
      ok: options.dryRun ? null : true,
      dryRun: options.dryRun ?? false,
      summary: { total: 4, passed: 4, failed: 0, warnings: 0, blocking: 0, errors: 0 },
      results: [],
      generatedAt: new Date().toISOString(),
    });
  }
  class FakeAdapter {}
  return {
    GuardEngine: FakeEngine,
    GuardESLintCheckAdapter: FakeAdapter,
    GuardSensitiveInfoAdapter: FakeAdapter,
    FileSecretStateLookup: FakeAdapter,
    ArchitectureBoundaryAdapter: FakeAdapter,
    TestRunnerAdapter: FakeAdapter,
    SecurityScanAdapter: FakeAdapter,
  };
});

describe('GuardService', () => {
  let service: GuardService;

  beforeEach(() => {
    service = new GuardService();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(service).toBeDefined();
    });

    it('should have an engine', () => {
      const engine = (service as unknown as { engine: GuardEngine }).engine;
      expect(engine).toBeDefined();
    });
  });

  describe('runCheck', () => {
    it('should run a guard check and return a report', async () => {
      const report = await service.runCheck(process.cwd());
      expect(report).toBeDefined();
      expect(report.contractVersion).toBe('p0.v1');
      expect(report.mode).toBe('guard');
      expect(report.summary).toBeDefined();
      expect(typeof report.summary.total).toBe('number');
      expect(typeof report.summary.passed).toBe('number');
      expect(typeof report.summary.failed).toBe('number');
      expect(report.generatedAt).toBeDefined();
    });

    it('should support dryRun mode', async () => {
      const report = await service.runCheck(process.cwd(), { dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.ok).toBeNull();
    });

    it('should have results array', async () => {
      const report = await service.runCheck(process.cwd());
      expect(Array.isArray(report.results)).toBe(true);
    });
  });
});
