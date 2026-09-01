import { describe, it, expect, beforeEach } from 'vitest';
import { EvolveEngine } from '../engine';

describe('EvolveEngine', () => {
  let engine: EvolveEngine;

  beforeEach(() => {
    engine = new EvolveEngine();
  });

  describe('Experience CRUD', () => {
    it('should record an experience', () => {
      const exp = engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'RULE-001',
        type: 'true-positive',
        pattern: 'no-var',
        message: 'Use let instead of var',
        feedback: 'Good catch',
        source: 'user',
        confidence: 0.9,
        verified: false,
      });
      expect(exp.id).toBeDefined();
      expect(exp.ruleId).toBe('RULE-001');
      expect(exp.type).toBe('true-positive');
      expect(exp.createdAt).toBeInstanceOf(Date);
    });

    it('should list experiences for a project', () => {
      engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'R1',
        type: 'true-positive',
        pattern: 'a',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'proj-2',
        ruleId: 'R2',
        type: 'false-positive',
        pattern: 'b',
        message: 'm',
        feedback: 'f',
        source: 'auto',
        confidence: 0.5,
        verified: false,
      });

      const proj1 = engine.listExperiences('proj-1');
      expect(proj1).toHaveLength(1);
      expect(proj1[0].projectId).toBe('proj-1');

      const all = engine.listExperiences();
      expect(all).toHaveLength(2);
    });

    it('should list experiences sorted by createdAt descending', async () => {
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'true-positive',
        pattern: 'a',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });
      await new Promise((r) => setTimeout(r, 5));
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R2',
        type: 'false-positive',
        pattern: 'b',
        message: 'm',
        feedback: 'f',
        source: 'auto',
        confidence: 0.5,
        verified: false,
      });

      const all = engine.listExperiences();
      expect(all[0].ruleId).toBe('R2');
      expect(all[1].ruleId).toBe('R1');
    });
  });

  describe('Suggestions', () => {
    it('should generate suggestions for rules with high false-positive rate', () => {
      for (let i = 0; i < 5; i++) {
        engine.recordExperience({
          projectId: 'proj-1',
          ruleId: 'FP-RULE',
          type: 'false-positive',
          pattern: 'x',
          message: 'm',
          feedback: 'f',
          source: 'user',
          confidence: 0.8,
          verified: false,
        });
      }

      const suggestions = engine.getSuggestions('proj-1');
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      const fpSuggestion = suggestions.find((s) => s.ruleId === 'FP-RULE');
      expect(fpSuggestion).toBeDefined();
      expect(fpSuggestion!.confidence).toBeLessThan(0.5);
    });

    it('should not suggest for rules with few samples', () => {
      engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });

      const suggestions = engine.getSuggestions('proj-1');
      const r1 = suggestions.find((s) => s.ruleId === 'R1');
      expect(r1).toBeUndefined();
    });

    it('should not suggest for rules with low false-positive rate', () => {
      engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'GOOD-RULE',
        type: 'true-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'GOOD-RULE',
        type: 'true-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'proj-1',
        ruleId: 'GOOD-RULE',
        type: 'true-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });

      const suggestions = engine.getSuggestions('proj-1');
      const s = suggestions.find((s) => s.ruleId === 'GOOD-RULE');
      expect(s).toBeUndefined();
    });

    it('should filter suggestions by ruleId', () => {
      for (let i = 0; i < 3; i++) {
        engine.recordExperience({
          projectId: 'proj-1',
          ruleId: 'A',
          type: 'false-positive',
          pattern: 'x',
          message: 'm',
          feedback: 'f',
          source: 'user',
          confidence: 0.8,
          verified: false,
        });
        engine.recordExperience({
          projectId: 'proj-1',
          ruleId: 'B',
          type: 'false-positive',
          pattern: 'x',
          message: 'm',
          feedback: 'f',
          source: 'user',
          confidence: 0.8,
          verified: false,
        });
      }

      const aOnly = engine.getSuggestions('proj-1', { ruleId: 'A' });
      expect(aOnly).toHaveLength(1);
      expect(aOnly[0].ruleId).toBe('A');
    });
  });

  describe('Rule State Management', () => {
    it('should change rule state', () => {
      const entry = engine.changeRuleState(
        'RULE-001',
        'deprecated',
        'Superseded by RULE-002',
        'admin',
      );
      expect(entry.ruleId).toBe('RULE-001');
      expect(entry.state).toBe('deprecated');
      expect(entry.changedBy).toBe('admin');
    });

    it('should get current rule state', () => {
      engine.changeRuleState('RULE-001', 'promoted', 'High accuracy', 'system');
      const state = engine.getRuleState('RULE-001');
      expect(state).toBeDefined();
      expect(state!.state).toBe('promoted');
    });

    it('should return undefined for unknown rule', () => {
      expect(engine.getRuleState('UNKNOWN')).toBeUndefined();
    });
  });

  describe('Auto-Adjust Weights', () => {
    it('should compute weights based on false-positive rate', () => {
      for (let i = 0; i < 5; i++) {
        engine.recordExperience({
          projectId: 'p',
          ruleId: 'FP-RULE',
          type: 'false-positive',
          pattern: 'x',
          message: 'm',
          feedback: 'f',
          source: 'user',
          confidence: 0.8,
          verified: false,
        });
      }
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'FP-RULE',
        type: 'true-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });

      const results = engine.autoAdjustWeights();
      const fpRule = results.find((r) => r.ruleId === 'FP-RULE');
      expect(fpRule).toBeDefined();
      expect(fpRule!.weight).toBeLessThan(1.0);
      expect(fpRule!.falsePositiveRate).toBeGreaterThan(0);
      expect(fpRule!.totalSamples).toBe(6);
    });

    it('should keep weight at 1.0 for rules with few samples', () => {
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'NEW-RULE',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });

      const results = engine.autoAdjustWeights();
      const rule = results.find((r) => r.ruleId === 'NEW-RULE');
      expect(rule!.weight).toBe(1.0);
    });

    it('should return empty array when no experiences exist', () => {
      const results = engine.autoAdjustWeights();
      expect(results).toEqual([]);
    });

    it('should get individual rule weight', () => {
      engine.autoAdjustWeights();
      expect(engine.getRuleWeight('NON-EXISTENT')).toBe(1.0);
    });

    it('should get all rule weights', () => {
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });

      engine.autoAdjustWeights();
      const all = engine.getRuleWeights();
      expect(all.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Cloud Sync', () => {
    it('should sync to cloud with auto-generated clientId', () => {
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'true-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 1,
        verified: false,
      });
      engine.changeRuleState('R1', 'active', 'test', 'admin');
      engine.autoAdjustWeights();

      const payload = engine.syncToCloud();
      expect(payload.clientId).toBeDefined();
      expect(payload.syncedAt).toBeDefined();
      expect(payload.totalSynced).toBeGreaterThanOrEqual(0);
    });

    it('should use provided clientId', () => {
      engine.setClientId('my-client');
      const payload = engine.syncToCloud();
      expect(payload.clientId).toBe('my-client');
    });

    it('should sync from cloud and import weights and states', () => {
      const payload = engine.syncToCloud();
      const newEngine = new EvolveEngine();
      const result = newEngine.syncFromCloud(payload);
      expect(result.weightsImported).toBeGreaterThanOrEqual(0);
      expect(result.statesImported).toBeGreaterThanOrEqual(0);
    });

    it('should round-trip sync correctly', () => {
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });
      engine.recordExperience({
        projectId: 'p',
        ruleId: 'R1',
        type: 'false-positive',
        pattern: 'x',
        message: 'm',
        feedback: 'f',
        source: 'user',
        confidence: 0.8,
        verified: false,
      });
      engine.changeRuleState('R1', 'deprecated', 'Old rule', 'admin');
      engine.autoAdjustWeights();

      const payload = engine.syncToCloud();
      const newEngine = new EvolveEngine();
      newEngine.syncFromCloud(payload);

      expect(newEngine.getRuleWeights()).toHaveLength(engine.getRuleWeights().length);
      expect(newEngine.getRuleState('R1')?.state).toBe('deprecated');
    });
  });
});
