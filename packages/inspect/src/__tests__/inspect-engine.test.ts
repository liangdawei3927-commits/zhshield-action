import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { InspectEngine } from '../engine';
import { SopRuleEngine, SopRegistry } from '@zh/kernel';
import type { RuleEngineReport, SopRule } from '@zh/kernel';
import type { ToolAdapter } from '@zh/shared';

function makeMockAdapter(id: string, name: string): ToolAdapter {
  return {
    meta: { id, name, version: '1.0.0', description: `Mock ${name}` },
    isAvailable: vi.fn().mockResolvedValue(true),
    scan: vi.fn().mockResolvedValue({
      status: 'available',
      issues: [],
      metadata: { fileCount: 10 },
    }),
    normalize: vi.fn(),
  } as unknown as ToolAdapter;
}

describe('InspectEngine', () => {
  let engine: InspectEngine;

  beforeEach(() => {
    engine = new InspectEngine();
  });

  describe('adapter registration', () => {
    it('should register a ToolAdapter', () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      engine.registerAdapter(adapter);
      expect(engine.getToolManager()).toBeDefined();
    });

    it('should register a legacy adapter via runner', () => {
      const legacyAdapter = { name: 'legacy', run: vi.fn() };
      engine.registerAdapter(legacyAdapter);
      expect(engine).toBeDefined();
    });
  });

  describe('runScan', () => {
    it('should return empty report when no adapters registered', async () => {
      const report = await engine.runScan('proj-1');
      expect(report.projectId).toBe(path.resolve('proj-1'));
      expect(report.scanType).toBe('full');
      expect(report.summary.total).toBe(0);
      expect(report.score.overall).toBe(100);
      expect(report.score.grade).toBe('A');
      expect(report.adapterResults).toHaveLength(0);
    });

    it('should run scan with registered adapter and return results', async () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      vi.mocked(adapter.scan).mockResolvedValue({
        status: 'available',
        issues: [
          {
            id: 'issue-1',
            ruleId: 'no-var',
            severity: 'warning',
            category: 'quality',
            message: 'Use let/const',
            file: 'src/app.ts',
            line: 10,
            column: 5,
            autoFixable: true,
            source: 'eslint',
            fingerprint: 'no-var:src/app.ts:10',
          },
        ],
        metadata: { fileCount: 50 },
      });

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1');

      expect(report.projectId).toBe(path.resolve('proj-1'));
      expect(report.summary.total).toBe(1);
      expect(report.summary.warning).toBe(1);
      expect(report.score.overall).toBeLessThan(100);
      expect(report.adapterResults).toHaveLength(1);
      expect(report.adapterResults[0].passed).toBe(true);
      expect(report.adapterResults[0].issueCount).toBe(1);
    });

    it('should handle adapter errors gracefully', async () => {
      const adapter = makeMockAdapter('broken', 'Broken');
      vi.mocked(adapter.scan).mockRejectedValue(new Error('Adapter crashed'));

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1');

      expect(report.summary.total).toBe(1);
      expect(report.summary.error).toBe(1);
      expect(report.adapterResults[0].passed).toBe(false);
      expect(report.adapterResults[0].issues[0].message).toBe('Adapter crashed');
    });

    it('should calculate grade correctly', async () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      vi.mocked(adapter.scan).mockResolvedValue({
        status: 'available',
        issues: Array.from({ length: 15 }, (_, i) => ({
          id: `err-${i}`,
          ruleId: 'rule',
          severity: 'error',
          category: 'quality',
          message: 'error',
          file: 'src/file.ts',
          line: i,
          column: 0,
          autoFixable: false,
          source: 'eslint',
          fingerprint: `rule:${i}`,
        })),
        metadata: { fileCount: 10 },
      });

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1');

      expect(report.score.overall).toBeLessThan(50);
      expect(report.score.grade).toBe('D');
    });

    it('should generate recommendations for many issues', async () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      vi.mocked(adapter.scan).mockResolvedValue({
        status: 'available',
        issues: Array.from({ length: 10 }, (_, i) => ({
          id: `q-${i}`,
          ruleId: 'rule',
          severity: 'warning',
          category: 'quality',
          message: 'warning',
          file: 'src/file.ts',
          line: i,
          column: 0,
          autoFixable: false,
          source: 'eslint',
          fingerprint: `rule:${i}`,
        })),
        metadata: { fileCount: 10 },
      });

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1');

      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations.some((r) => r.includes('quality'))).toBe(true);
    });

    it('should suppress baseline-matched issues and report suppressedCount', async () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      vi.mocked(adapter.scan).mockResolvedValue({
        status: 'available',
        issues: [
          {
            id: 'issue-1',
            ruleId: 'no-var',
            severity: 'warning',
            category: 'quality',
            message: 'Use let/const',
            file: 'src/app.ts',
            line: 10,
            column: 5,
            autoFixable: true,
            source: 'eslint',
            fingerprint: 'no-var:src/app.ts:10',
          },
          {
            id: 'issue-2',
            ruleId: 'no-var',
            severity: 'error',
            category: 'quality',
            message: 'Unused var',
            file: 'src/app.ts',
            line: 42,
            column: 1,
            autoFixable: false,
            source: 'eslint',
            fingerprint: 'no-var:src/app.ts:42',
          },
        ],
        metadata: { fileCount: 50 },
      });
      const baseline = {
        version: 1 as const,
        capturedAt: '2026-01-01T00:00:00.000Z',
        entries: [{ ruleId: 'no-var', file: 'src/app.ts', line: 10, column: 5 }],
      };

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1', 'full', undefined, baseline);

      expect(report.summary.total).toBe(1);
      expect(report.issues[0].id).toBe('issue-2');
      expect(report.suppressedCount).toBe(1);
    });

    it('should not suppress when baseline is null', async () => {
      const adapter = makeMockAdapter('eslint', 'ESLint');
      vi.mocked(adapter.scan).mockResolvedValue({
        status: 'available',
        issues: [
          {
            id: 'issue-1',
            ruleId: 'no-var',
            severity: 'warning',
            category: 'quality',
            message: 'Use let/const',
            file: 'src/app.ts',
            line: 10,
            column: 5,
            autoFixable: true,
            source: 'eslint',
            fingerprint: 'no-var:src/app.ts:10',
          },
        ],
        metadata: { fileCount: 50 },
      });

      engine.registerAdapter(adapter);
      const report = await engine.runScan('proj-1');

      expect(report.summary.total).toBe(1);
      expect(report.suppressedCount).toBe(0);
    });
  });

  describe('runScan (SOP 模式) — 基线过滤后 adapterResults 重算', () => {
    function makeRule(id: string, name: string): SopRule {
      return {
        id,
        name,
        domain: 'inspect',
        action: 'allow',
        source: 'official',
        description: '',
        status: 'active',
        executionMode: 'sync',
        severity: 'high',
        applicableEngines: ['inspect'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function makeReportWithViolation(ruleId: string, file: string, line: number): RuleEngineReport {
      return {
        total: 1,
        passed: 0,
        failed: 1,
        errors: 0,
        skipped: 0,
        ok: false,
        evaluations: [
          {
            rule: makeRule(ruleId, '循环依赖检测'),
            status: 'failed',
            message: 'found',
            files: [file],
            violations: [
              {
                id: 'violation-1',
                ruleId,
                severity: 'high',
                file,
                line,
                column: 0,
                message: `架构边界违规: no-circular - ${file} → other.ts`,
              },
            ],
            durationMs: 5,
            targetEngine: 'inspect',
            timestamp: new Date(),
          },
        ],
        durationMs: 5,
        timestamp: new Date(),
      };
    }

    it('全部违规被基线豁免 → adapterResult 翻转为 passed，不再显示 failed', async () => {
      const registry = new SopRegistry();
      const sop = new SopRuleEngine(registry);
      const reportWithViolation = makeReportWithViolation(
        'inspect.scan.depcruiser.circular-dependency',
        'src/a.ts',
        0,
      );
      vi.spyOn(sop, 'evaluateRules').mockImplementation(async (ctx) =>
        ctx.domain === 'inspect'
          ? reportWithViolation
          : { ...reportWithViolation, evaluations: [] },
      );
      engine.useSopEngine(sop);

      const baseline = {
        version: 1 as const,
        capturedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            ruleId: 'inspect.scan.depcruiser.circular-dependency',
            file: 'src/a.ts',
            line: 0,
            column: 0,
          },
        ],
      };

      const report = await engine.runScan('proj-1', 'full', undefined, baseline);

      expect(report.summary.total).toBe(0);
      expect(report.suppressedCount).toBe(1);
      const depResult = report.adapterResults.find(
        (r) => r.adapterId === 'inspect.scan.depcruiser.circular-dependency',
      );
      expect(depResult).toBeDefined();
      expect(depResult!.passed).toBe(true);
      expect(depResult!.status).toBe('passed');
      expect(depResult!.issueCount).toBe(0);
      expect(report.score.overall).toBe(100);
    });

    it('基线未命中 → adapterResult 保持 failed，问题数不变', async () => {
      const registry = new SopRegistry();
      const sop = new SopRuleEngine(registry);
      const reportWithViolation = makeReportWithViolation(
        'inspect.scan.depcruiser.circular-dependency',
        'src/b.ts',
        0,
      );
      vi.spyOn(sop, 'evaluateRules').mockImplementation(async (ctx) =>
        ctx.domain === 'inspect'
          ? reportWithViolation
          : { ...reportWithViolation, evaluations: [] },
      );
      engine.useSopEngine(sop);

      const baseline = {
        version: 1 as const,
        capturedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            ruleId: 'inspect.scan.depcruiser.circular-dependency',
            file: 'src/a.ts',
            line: 0,
            column: 0,
          },
        ],
      };

      const report = await engine.runScan('proj-1', 'full', undefined, baseline);

      expect(report.summary.total).toBe(1);
      expect(report.suppressedCount).toBe(0);
      const depResult = report.adapterResults.find(
        (r) => r.adapterId === 'inspect.scan.depcruiser.circular-dependency',
      );
      expect(depResult!.passed).toBe(false);
      expect(depResult!.status).toBe('failed');
      expect(depResult!.issueCount).toBe(1);
    });
  });
});
