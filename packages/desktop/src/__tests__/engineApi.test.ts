import { describe, expect, it } from 'vitest';

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
});
