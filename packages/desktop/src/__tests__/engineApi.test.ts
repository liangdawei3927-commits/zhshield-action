import { describe, expect, it, vi } from 'vitest';
import {
  runDeps,
  runTechDebt,
  runSecrets,
  markSecretRotating,
  verifySecretRotated,
  dismissSecret,
} from '../services/engineApi';

const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/**
 * engineApi 在无 Electron / 无 HTTP 时返回空报告结构，避免桌面端白屏。
 * 此处校验契约形状（不依赖 window.electronAPI）。
 */
describe('engineApi fallback contracts', () => {
  it('defines empty guard report shape', () => {
    const emptyGuard = {
      summary: { totalChecks: 0, passed: 0, blocked: 0, warnings: 0 },
      checks: [] as unknown[],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };

    expect(emptyGuard.summary.totalChecks).toBe(0);
    expect(Array.isArray(emptyGuard.checks)).toBe(true);
    expect(emptyGuard.metadata.timestamp).toMatch(ISO_TIMESTAMP_PREFIX);
  });

  it('defines empty inspect report shape', () => {
    const emptyInspect = {
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      results: [] as unknown[],
    };

    expect(emptyInspect.summary.failures).toBe(0);
    expect(emptyInspect.results).toEqual([]);
  });

  it('defines empty garbage clean result shape', () => {
    const emptyClean = {
      batchId: '',
      cleaned: [] as Array<{ id: string; path: string; size: number }>,
      freedBytes: 0,
      failed: [] as string[],
    };

    expect(emptyClean.batchId).toBe('');
    expect(emptyClean.freedBytes).toBe(0);
    expect(emptyClean.cleaned).toEqual([]);
    expect(emptyClean.failed).toEqual([]);
  });

  it('defines empty garbage restore result shape', () => {
    const emptyRestore = {
      restored: 0,
      restoredBytes: 0,
      failed: [] as string[],
    };

    expect(emptyRestore.restored).toBe(0);
    expect(emptyRestore.restoredBytes).toBe(0);
    expect(Array.isArray(emptyRestore.failed)).toBe(true);
  });

  it('returns empty deps report when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      const report = await runDeps('/tmp/nonexistent-project');

      expect(report.schemaVersion).toBe(0);
      expect(report.targetId).toBe('');
      expect(report.ecosystem).toBe('mixed');
      expect(report.direct).toBe(0);
      expect(report.transitive).toBe(0);
      expect(report.total).toBe(0);
      expect(report.edgeCount).toBe(0);
      expect(report.lockfile).toEqual({ present: false, consistent: false, integrityVerified: false });
      expect(report.trustCounts).toEqual({});
      expect(report.licenseMatrix).toEqual({ total: 0, byCategory: {}, entries: [] });
      expect(report.generatedAt).toMatch(ISO_TIMESTAMP_PREFIX);
      expect(report.error).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns empty tech debt report when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      const report = await runTechDebt('/tmp/nonexistent-project');

      expect(report.projectId).toBe('');
      expect(report.debtIndex).toBe(0);
      expect(report.trend).toEqual({ period: 'week', delta: 0 });
      expect(report.byModule).toEqual([]);
      expect(report.byCategory).toEqual([]);
      expect(report.actionList).toEqual([]);
      expect(report.generatedAt).toMatch(ISO_TIMESTAMP_PREFIX);
      expect(report.error).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns empty secrets report when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      const report = await runSecrets('/tmp/nonexistent-project');

      expect(report.findings).toEqual([]);
      expect(report.summary).toEqual({ total: 0, critical: 0, active: 0, historyFound: 0 });
      expect(report.lastScannedCommit).toBe('');
      expect(report.error).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns false for verifySecretRotated when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      await expect(verifySecretRotated('a'.repeat(64))).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves markSecretRotating when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      await expect(markSecretRotating('a'.repeat(64))).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves dismissSecret when window.electronAPI is absent', async () => {
    vi.stubGlobal('window', {});
    try {
      await expect(dismissSecret('a'.repeat(64), 'false positive')).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
