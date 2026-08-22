import { describe, it, expect } from 'vitest';
import { ScoringEngine } from '../scoring-engine';
import type { ScoringRuleContext, ScoringConfig } from '../types';

const cleanContext: ScoringRuleContext = {
  findings: [],
  metrics: {
    dependencyCount: 10,
    testCoverage: 80,
    circularDependencies: 0,
    totalFiles: 20,
    documentationCoverage: 50,
  },
};

function singleDimConfig(perIssuePenalty: number, multiplier: number): ScoringConfig {
  return {
    version: 'test',
    lastUpdated: new Date(),
    dimensions: [
      {
        id: 'quality',
        name: '质量',
        weight: 1,
        description: '',
        penalties: {
          dimension: 'quality',
          maxPenalty: 100,
          perIssuePenalty,
          severityMultipliers: { error: multiplier },
        },
        positiveRules: [],
      },
    ],
  };
}

describe('ScoringEngine (context scoring)', () => {
  it('clean context scores every dimension 100 with positive bonuses clamped', () => {
    const engine = new ScoringEngine();
    const result = engine.score(cleanContext);

    expect(result.overall).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.dimensions.every((d) => d.score === 100)).toBe(true);
    expect(result.negativePoints).toBe(0);
    // security 15 + quality 13 + architecture 15 + dependencies 5 + documentation 3
    expect(result.positivePoints).toBe(51);
  });

  it('applies severity multipliers to per-issue penalties', () => {
    const engine = new ScoringEngine();
    const result = engine.score({
      findings: [{ severity: 'critical', category: 'security' }],
      metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
    });

    const security = result.details.find((d) => d.dimension === 'security');
    // critical → ×3 on perIssuePenalty 5
    expect(security?.negative).toBe(15);
    expect(security?.score).toBe(85);
    expect(security?.issues).toBe(1);
    expect(result.overall).toBeCloseTo(94.75, 2);
  });

  it('caps dimension penalty at maxPenalty', () => {
    const engine = new ScoringEngine();
    const result = engine.score({
      findings: Array.from({ length: 7 }, () => ({
        severity: 'critical',
        category: 'security',
      })),
      metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
    });

    const security = result.details.find((d) => d.dimension === 'security');
    // 7 × (5 × 3) = 105 → capped at 30
    expect(security?.negative).toBe(30);
    expect(security?.score).toBe(70);
  });

  it('falls back to multiplier 1 for unknown severities', () => {
    const engine = new ScoringEngine();
    const result = engine.score({
      findings: [{ severity: 'catastrophic', category: 'documentation' }],
      metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
    });

    const doc = result.details.find((d) => d.dimension === 'documentation');
    expect(doc?.negative).toBe(1);
    expect(doc?.score).toBe(99);
  });

  it('maps weighted overall to grades A/B/C/D at boundaries', () => {
    // single dimension weight 1 → overall equals the dimension score exactly
    const cases: Array<{ errors: number; perIssue: number; mult: number; grade: string }> = [
      { errors: 1, perIssue: 5, mult: 2, grade: 'A' }, // 90
      { errors: 2, perIssue: 5, mult: 2, grade: 'B' }, // 80
      { errors: 2, perIssue: 10, mult: 2, grade: 'C' }, // 60
      { errors: 3, perIssue: 10, mult: 2, grade: 'D' }, // 40
    ];

    for (const { errors, perIssue, mult, grade } of cases) {
      const engine = new ScoringEngine(singleDimConfig(perIssue, mult));
      const result = engine.score({
        findings: Array.from({ length: errors }, () => ({
          severity: 'error',
          category: 'quality',
        })),
        metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
      });
      expect(result.grade).toBe(grade);
    }
  });

  it('updateConfig swaps the active config used by score()', () => {
    const engine = new ScoringEngine();
    const custom = singleDimConfig(50, 1);

    engine.updateConfig(custom);
    expect(engine.getConfig().version).toBe('test');

    const result = engine.score({
      findings: [{ severity: 'error', category: 'quality' }],
      metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
    });
    expect(result.overall).toBe(50);
  });
});
