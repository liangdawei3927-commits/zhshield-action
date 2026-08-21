import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InspectEngine } from '../engine';
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
      expect(report.projectId).toBe('proj-1');
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

      expect(report.projectId).toBe('proj-1');
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
  });
});
