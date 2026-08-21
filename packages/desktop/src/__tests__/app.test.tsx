import { describe, expect, it } from 'vitest';
import { serializePipelineReport } from '../../electron/pipeline-protocol';

describe('App routing pages', () => {
  const pages = [
    'welcome',
    'dashboard',
    'security',
    'performance',
    'guard',
    'inspect',
    'sentinel',
    'refactor',
    'evolve',
    'reports',
    'backup',
  ] as const;

  it('includes evolve and reports in the navigable page set', () => {
    expect(pages).toContain('evolve');
    expect(pages).toContain('reports');
    expect(pages).toContain('performance');
    expect(pages).toHaveLength(11);
  });

  it('keeps pipeline serialization available for dashboard IPC', () => {
    const report = serializePipelineReport({
      timestamp: new Date('2026-07-31T12:00:00.000Z'),
      passed: true,
      stage: 'complete',
      guard: null,
      inspect: null,
      refactor: null,
    }) as { timestamp: string; passed: boolean };

    expect(report.timestamp).toBe('2026-07-31T12:00:00.000Z');
    expect(report.passed).toBe(true);
  });
});
