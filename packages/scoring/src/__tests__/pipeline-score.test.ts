import { describe, it, expect } from 'vitest';
import { buildHealthDimensions, type GuardReportLike, type InspectionReportLike } from '../pipeline-score';

const cleanGuard: GuardReportLike = { results: [] };
const cleanInspect: InspectionReportLike = { issues: [] };

describe('buildHealthDimensions', () => {
  it('all clean reports score 100 on every dimension', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect);
    expect(dims).toHaveLength(5);
    expect(dims.map((d) => d.name)).toEqual([
      'security', 'quality', 'architecture', 'dependencies', 'documentation',
    ]);
    expect(dims.every((d) => d.score === 100)).toBe(true);
    expect(dims.every((d) => d.issues === 0)).toBe(true);
  });

  it('dimension weights sum to 1', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect);
    const sum = dims.reduce((acc, d) => acc + d.weight, 0);
    expect(sum).toBe(1);
  });

  it('maps inspect issues to their dimension by category', () => {
    const dims = buildHealthDimensions(cleanGuard, {
      issues: [
        { severity: 'error' as const, category: 'security' },
        { severity: 'warning' as const, category: 'architecture' },
        { severity: 'error' as const, category: 'performance' },
        { severity: 'info' as const, category: 'documentation' },
        { severity: 'warning' as const, category: 'test' },
        { severity: 'error' as const, category: 'refactoring' },
        { severity: 'warning' as const, category: 'dependency' },
        { severity: 'info' as const, category: 'quality' },
      ],
    });

    const byName = Object.fromEntries(dims.map((d) => [d.name, d]));
    expect(byName.security.score).toBe(92);
    expect(byName.security.issues).toBe(1);
    expect(byName.quality.score).toBe(91);
    expect(byName.quality.issues).toBe(2);
    expect(byName.architecture.score).toBe(88);
    expect(byName.architecture.issues).toBe(2);
    expect(byName.documentation.score).toBe(99);
    expect(byName.documentation.issues).toBe(1);
    expect(byName.dependencies.score).toBe(92);
    expect(byName.dependencies.issues).toBe(2);
  });

  it('counts only non-passed guard results as security issues', () => {
    const dims = buildHealthDimensions(
      {
        results: [
          { severity: 'error' as const, status: 'failed' as const, blocking: true },
          { severity: 'warning' as const, status: 'warning' as const, blocking: false },
          { severity: 'info' as const, status: 'passed' as const, blocking: false },
        ],
      },
      cleanInspect,
    );

    const byName = Object.fromEntries(dims.map((d) => [d.name, d]));
    expect(byName.security.score).toBe(88);
    expect(byName.security.issues).toBe(2);
    expect(byName.architecture.score).toBe(100);
    expect(byName.quality.score).toBe(100);
  });

  it('floors dimension score at 0', () => {
    const dims = buildHealthDimensions(cleanGuard, {
      issues: Array.from({ length: 20 }, () => ({
        severity: 'error' as const,
        category: 'security',
      })),
    });
    expect(dims[0].score).toBe(0);
  });
});
