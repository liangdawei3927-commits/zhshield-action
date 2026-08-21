import { describe, it, expect, beforeEach } from 'vitest';
import { EvolveService } from '../evolve/evolve.service';

describe('EvolveService', () => {
  let service: EvolveService;

  beforeEach(() => {
    service = new EvolveService();
  });

  describe('recordExperience', () => {
    it('should record a true-positive experience', async () => {
      const entry = await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'RULE-001',
        type: 'true-positive',
        detail: 'Found real SQL injection',
        source: 'user',
      });

      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.ruleId).toBe('RULE-001');
      expect(entry.type).toBe('true-positive');
      expect(entry.createdAt).toBeInstanceOf(Date);
    });

    it('should record a false-positive experience', async () => {
      const entry = await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'RULE-002',
        type: 'false-positive',
        detail: 'Not a real issue',
        source: 'user',
      });

      expect(entry.type).toBe('false-positive');
    });
  });

  describe('listExperiences', () => {
    it('should return empty array initially', async () => {
      const list = await service.listExperiences('proj-1');
      expect(list).toEqual([]);
    });

    it('should list experiences after recording', async () => {
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'RULE-001',
        type: 'true-positive',
      });
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'RULE-001',
        type: 'false-positive',
      });

      const list = await service.listExperiences('proj-1');
      expect(list).toHaveLength(2);
    });

    it('should filter by project', async () => {
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'R1',
        type: 'true-positive',
      });
      await service.recordExperience({
        projectId: 'proj-2',
        ruleId: 'R1',
        type: 'true-positive',
      });

      const proj1 = await service.listExperiences('proj-1');
      const proj2 = await service.listExperiences('proj-2');
      expect(proj1).toHaveLength(1);
      expect(proj2).toHaveLength(1);
    });
  });

  describe('autoAdjustWeights', () => {
    it('should return empty array with no experiences', async () => {
      const weights = await service.autoAdjustWeights();
      expect(weights).toEqual([]);
    });

    it('should compute weights based on false-positive rate', async () => {
      // Record 3 experiences: 2 false-positives, 1 true-positive
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'FP-RULE',
        type: 'false-positive',
      });
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'FP-RULE',
        type: 'false-positive',
      });
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'FP-RULE',
        type: 'true-positive',
      });

      const weights = await service.autoAdjustWeights();
      expect(weights).toHaveLength(1);
      expect(weights[0].ruleId).toBe('FP-RULE');
      expect(weights[0].weight).toBeLessThan(1.0);
      expect(weights[0].falsePositiveRate).toBeCloseTo(2 / 3, 2);
      expect(weights[0].totalSamples).toBe(3);
    });

    it('should keep weight at 1.0 with no false positives', async () => {
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'GOOD-RULE',
        type: 'true-positive',
      });
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'GOOD-RULE',
        type: 'true-positive',
      });

      const weights = await service.autoAdjustWeights();
      expect(weights[0].weight).toBe(1.0);
      expect(weights[0].falsePositiveRate).toBe(0);
    });
  });

  describe('getRuleWeight', () => {
    it('should return default weight 1.0 for unknown rule', async () => {
      const result = await service.getRuleWeight('UNKNOWN');
      expect(result).toEqual({ ruleId: 'UNKNOWN', weight: 1.0 });
    });
  });

  describe('changeRuleState', () => {
    it('should change rule state', async () => {
      const result = await service.changeRuleState('RULE-001', 'disabled', 'Too noisy', 'admin');
      expect(result.ruleId).toBe('RULE-001');
      expect(result.state).toBe('disabled');
      expect(result.reason).toBe('Too noisy');
      expect(result.changedBy).toBe('admin');
    });

    it('should retrieve rule state', async () => {
      await service.changeRuleState('RULE-002', 'deprecated', 'Superseded', 'admin');
      const state = await service.getRuleState('RULE-002');
      expect(state).toBeDefined();
      expect(state!.state).toBe('deprecated');
    });

    it('should return undefined for unknown rule state', async () => {
      const state = await service.getRuleState('UNKNOWN');
      expect(state).toBeUndefined();
    });
  });

  describe('getSuggestions', () => {
    it('should return empty array with no data', async () => {
      const suggestions = await service.getSuggestions('proj-1');
      expect(suggestions).toEqual([]);
    });

    it('should suggest when false-positive rate is high', async () => {
      // Record enough false-positives to trigger suggestion
      for (let i = 0; i < 4; i++) {
        await service.recordExperience({
          projectId: 'proj-1',
          ruleId: 'NOISY-RULE',
          type: 'false-positive',
        });
      }
      await service.recordExperience({
        projectId: 'proj-1',
        ruleId: 'NOISY-RULE',
        type: 'true-positive',
      });

      const suggestions = await service.getSuggestions('proj-1');
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions[0].ruleId).toBe('NOISY-RULE');
    });
  });
});
