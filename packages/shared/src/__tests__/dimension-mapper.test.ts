import { describe, it, expect } from 'vitest';
import { getToolDimensions, mapIssuesToDimensions, computeOverallScore, scoreToGrade } from '../dimension-mapper';
import type { Issue, ToolId } from '../types';

function makeIssue(overrides: Partial<Issue> & { id: string; category: Issue['category']; severity: Issue['severity'] }): Issue {
  return {
    ruleId: 'RULE-1',
    message: 'test issue',
    file: 'test.ts',
    autoFixable: false,
    source: 'test',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

describe('dimension-mapper', () => {
  describe('getToolDimensions', () => {
    it('should return security for semgrep', () => {
      expect(getToolDimensions('semgrep')).toEqual(['security']);
    });

    it('should return security+dependency for trivy', () => {
      expect(getToolDimensions('trivy')).toEqual(['security', 'dependency']);
    });

    it('should return quality+performance+documentation for eslint', () => {
      expect(getToolDimensions('eslint')).toEqual(['quality', 'performance', 'documentation']);
    });

    it('should return architecture for dep-cruiser', () => {
      expect(getToolDimensions('dep-cruiser')).toEqual(['architecture']);
    });

    it('should default to quality for unknown tool', () => {
      expect(getToolDimensions('unknown-tool' as unknown as ToolId)).toEqual(['quality']);
    });
  });

  describe('mapIssuesToDimensions', () => {
    it('should return empty array for no issues', () => {
      expect(mapIssuesToDimensions([])).toEqual([]);
    });

    it('should group issues by category and compute scores', () => {
      const issues: Issue[] = [
        makeIssue({ id: '1', category: 'security', severity: 'error' }),
        makeIssue({ id: '2', category: 'security', severity: 'warning' }),
        makeIssue({ id: '3', category: 'quality', severity: 'info' }),
      ];

      const dims = mapIssuesToDimensions(issues);
      expect(dims).toHaveLength(2);

      const security = dims.find((d) => d.name === 'security');
      expect(security).toBeDefined();
      expect(security!.issues).toBe(2);
      expect(security!.weight).toBe(0.25);
      expect(security!.score).toBe(80);

      const quality = dims.find((d) => d.name === 'quality');
      expect(quality).toBeDefined();
      expect(quality!.issues).toBe(1);
      expect(quality!.score).toBe(99);
    });

    it('should compute zero score for many errors', () => {
      const issues: Issue[] = Array.from({ length: 10 }, (_, i) =>
        makeIssue({ id: `${i}`, category: 'security', severity: 'error' }),
      );

      const dims = mapIssuesToDimensions(issues);
      const security = dims.find((d) => d.name === 'security')!;
      expect(security.score).toBe(0);
    });
  });

  describe('computeOverallScore', () => {
    it('should return 100 for empty dimensions', () => {
      expect(computeOverallScore([])).toBe(100);
    });

    it('should compute weighted average', () => {
      const dims = [
        { name: 'security' as const, weight: 0.25, score: 80, issues: 2 },
        { name: 'quality' as const, weight: 0.20, score: 100, issues: 0 },
      ];
      const result = computeOverallScore(dims);
      expect(result).toBeCloseTo(88.89, 0);
    });
  });

  describe('scoreToGrade', () => {
    it('should return A for score >= 90', () => {
      expect(scoreToGrade(95)).toBe('A');
      expect(scoreToGrade(90)).toBe('A');
    });

    it('should return B for score >= 75', () => {
      expect(scoreToGrade(85)).toBe('B');
      expect(scoreToGrade(75)).toBe('B');
    });

    it('should return C for score >= 60', () => {
      expect(scoreToGrade(70)).toBe('C');
      expect(scoreToGrade(60)).toBe('C');
    });

    it('should return D for score < 60', () => {
      expect(scoreToGrade(50)).toBe('D');
      expect(scoreToGrade(0)).toBe('D');
    });
  });
});
