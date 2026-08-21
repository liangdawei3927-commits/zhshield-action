import { describe, it, expect, beforeEach } from 'vitest';
import { ScoringService } from '../scoring/scoring.service';
import type { DimensionScore, ScoringEngine } from '@zh/scoring';

describe('ScoringService', () => {
  let service: ScoringService;

  beforeEach(() => {
    service = new ScoringService();
  });

  describe('getScore', () => {
    it('should return undefined for unknown project', () => {
      const result = service.getScore('nonexistent-project');
      expect(result).toBeUndefined();
    });

    it('should return score after calculating one', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      const dimensions: DimensionScore[] = [
        { name: 'security', weight: 0.3, score: 90, issues: 0 },
        { name: 'quality', weight: 0.7, score: 80, issues: 2 },
      ];
      engine.calculate('proj-1', dimensions);

      const score = service.getScore('proj-1');
      expect(score).toBeDefined();
      expect(score!.projectId).toBe('proj-1');
      expect(score!.overall).toBe(83);
      expect(score!.grade).toBe('B');
      expect(score!.trend).toBe('stable');
    });

    it('should return A grade for score >= 90', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-a', [{ name: 's', weight: 1, score: 95, issues: 0 }]);
      expect(service.getScore('proj-a')!.grade).toBe('A');
    });

    it('should return C grade for score >= 60', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-c', [{ name: 's', weight: 1, score: 65, issues: 5 }]);
      expect(service.getScore('proj-c')!.grade).toBe('C');
    });

    it('should return D grade for score < 60', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-d', [{ name: 's', weight: 1, score: 40, issues: 10 }]);
      expect(service.getScore('proj-d')!.grade).toBe('D');
    });
  });

  describe('getHistory', () => {
    it('should return empty array for unknown project', () => {
      expect(service.getHistory('nonexistent')).toEqual([]);
    });

    it('should return score history in order', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-h', [{ name: 's', weight: 1, score: 70, issues: 3 }]);
      engine.calculate('proj-h', [{ name: 's', weight: 1, score: 85, issues: 1 }]);
      engine.calculate('proj-h', [{ name: 's', weight: 1, score: 92, issues: 0 }]);

      const history = service.getHistory('proj-h');
      expect(history).toHaveLength(3);
      expect(history[0].overall).toBe(70);
      expect(history[1].overall).toBe(85);
      expect(history[2].overall).toBe(92);
    });

    it('should detect improving trend', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-trend', [{ name: 's', weight: 1, score: 60, issues: 5 }]);
      engine.calculate('proj-trend', [{ name: 's', weight: 1, score: 80, issues: 2 }]);
      const history = service.getHistory('proj-trend');
      expect(history[1].trend).toBe('improving');
    });

    it('should detect declining trend', () => {
      const engine = (service as unknown as { engine: ScoringEngine }).engine;
      engine.calculate('proj-decline', [{ name: 's', weight: 1, score: 90, issues: 0 }]);
      engine.calculate('proj-decline', [{ name: 's', weight: 1, score: 70, issues: 3 }]);
      const history = service.getHistory('proj-decline');
      expect(history[1].trend).toBe('declining');
    });
  });
});
