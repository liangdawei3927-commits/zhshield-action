import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GuardService } from '../guard/guard.service';
import { GuardEngine } from '@zh/guard';
import type { Adapter, CheckConfig, CheckResult, GuardReport } from '@zh/guard';

// 与 vi.mock 工厂共享的 hoisted 状态（工厂被提升，无法引用普通顶层变量）
const mocks = vi.hoisted(() => {
  /** 每个 mock 适配器 run() 被调用时记录 check.adapter，用于证明扫描全部走 mock 边界 */
  const boundaryRuns: string[] = [];
  return { boundaryRuns };
});

// 仅替换扫描执行边界（六个适配器类）；GuardEngine 保持真实实现，
// 使 checks.json 加载 / 结果归一化 / 聚合统计都走真实代码路径。
// 测试因此绝不 shell out 到 eslint / trivy / git 等真实二进制。
vi.mock('@zh/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zh/guard')>();

  interface CheckLike {
    checkId: string;
    adapter: string;
    severity: 'error' | 'warning' | 'info';
    blocking: boolean;
  }

  const makePassedAdapter = (id: string) =>
    class {
      readonly adapterId = id;
      async run(_context: unknown, check: CheckLike): Promise<unknown> {
        mocks.boundaryRuns.push(check.adapter);
        return { findings: [] as unknown[] };
      }
      normalize(_raw: unknown, _context: unknown, check: CheckLike): CheckResult {
        return {
          checkId: check.checkId,
          adapter: check.adapter,
          status: 'passed',
          severity: 'info',
          blocking: false,
          message: `mock ${check.adapter} passed`,
        };
      }
    };

  // GuardTrivyAdapter mock：run() 返回罐化 GuardTrivyResult（1 个 CRITICAL），
  // normalize() 按真实适配器的映射规则（failed → check.severity / blocking）。
  const GuardTrivyAdapterMock = class {
    readonly adapterId = 'trivy';
    async run(_context: unknown, check: CheckLike): Promise<unknown> {
      mocks.boundaryRuns.push(check.adapter);
      return {
        adapterId: 'trivy',
        status: 'failed' as const,
        severity: 'critical' as const,
        message: 'Found 1 critical vulnerabilities',
        findings: [] as unknown[],
        summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
      };
    }
    normalize(
      raw: { status: 'passed' | 'failed' | 'error'; message: string },
      _context: unknown,
      check: CheckLike,
    ): CheckResult {
      return {
        checkId: check.checkId,
        adapter: check.adapter,
        status: raw.status,
        severity: raw.status === 'passed' ? ('info' as const) : check.severity,
        blocking: check.blocking && raw.status !== 'passed',
        message: raw.message,
      };
    }
  };

  return {
    ...actual,
    GuardESLintCheckAdapter: makePassedAdapter('eslint-check'),
    GuardSensitiveInfoAdapter: makePassedAdapter('sensitive-info'),
    ArchitectureBoundaryAdapter: makePassedAdapter('architecture-boundary'),
    TestRunnerAdapter: makePassedAdapter('test-runner'),
    SecurityScanAdapter: makePassedAdapter('security-scan'),
    GuardTrivyAdapter: GuardTrivyAdapterMock,
  };
});

const registerSpy = vi.spyOn(GuardEngine.prototype, 'registerAdapter');

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

function passingResult(adapter: string): CheckResult {
  return {
    checkId: `PASS-${adapter}`,
    adapter,
    status: 'passed',
    severity: 'info',
    blocking: false,
    message: 'mock passed',
  };
}

describe('GuardService', () => {
  let service: GuardService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundaryRuns.length = 0;
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

    it('should register trivy alongside the sibling scanners', () => {
      const names = registerSpy.mock.calls.map(([name]) => name);
      expect(names).toContain('eslint-check');
      expect(names).toContain('sensitive-info');
      expect(names).toContain('architecture-boundary');
      expect(names).toContain('test-runner');
      expect(names).toContain('security-scan');
      expect(names).toContain('trivy');
      for (const [, adapter] of registerSpy.mock.calls) {
        expect(adapter).toBeDefined();
      }
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

    it('should execute every checks.json check through the mocked scan boundary', async () => {
      const report = await service.runCheck(process.cwd());
      // checks.json guard 模式下的四个检查全部经由 mock 适配器执行 ——
      // 真实 eslint / test-runner / 安全扫描二进制从未被调用
      expect(report.summary.total).toBe(4);
      expect(mocks.boundaryRuns.toSorted()).toEqual([
        'architecture-boundary',
        'eslint-check',
        'security-scan',
        'test-runner',
      ]);
      expect(report.summary.passed).toBe(4);
    });

    it('should flow the canned GuardTrivyAdapter result through engine aggregation', async () => {
      const registration = registerSpy.mock.calls.find(([name]) => name === 'trivy');
      expect(registration).toBeDefined();
      const trivy = registration![1] as Adapter;

      const raw = (await trivy.run({ projectPath: '/tmp/demo-project' }, makeCheck())) as {
        status: string;
        summary: { critical: number };
      };
      expect(raw.status).toBe('failed');
      expect(raw.summary.critical).toBe(1);

      const result = trivy.normalize(raw, {}, makeCheck());
      expect(result.status).toBe('failed');
      expect(result.severity).toBe('error');
      expect(result.blocking).toBe(true);

      const engine = (service as unknown as { engine: GuardEngine }).engine;
      const report: GuardReport = engine.aggregateReport([passingResult('eslint-check'), result], {
        mode: 'guard',
        target: '/tmp/demo-project',
      });
      expect(report.summary.total).toBe(2);
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.blocking).toBe(1);
      expect(report.ok).toBe(false);
    });
  });
});
