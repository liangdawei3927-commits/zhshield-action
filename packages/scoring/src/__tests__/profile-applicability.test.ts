import { describe, expect, it } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { ScoringEngine } from '../engine';
import { resolveProfileScoring, applyDisabledDimensions } from '../profile-scoring-resolver';
import type { ScoringProjectProfile } from '@zh/fingerprint';

function makeProfile(type: ScoringProjectProfile['type']): ScoringProjectProfile {
  return {
    version: '1.0.0',
    projectRoot: '/test',
    language: 'typescript',
    secondaryLanguages: [],
    framework: 'nestjs',
    type,
    runtime: 'node',
    packageManager: 'pnpm',
    isMonorepo: false,
    detectedFiles: [],
    confidence: 0.8,
    detectedAt: new Date(),
    signals: [],
  };
}

const emptyGuard = { results: [] };
const emptyInspect = { issues: [] };

describe('resolveProfileScoring — 不适用维度解析', () => {
  it('cli 类型不再剔除任何维度（P1b 后无禁用项）', () => {
    expect(resolveProfileScoring(makeProfile('cli')).disabledDimensions).toBeUndefined();
  });

  it('mini-program 类型不再剔除任何维度（P1b 后无禁用项）', () => {
    expect(resolveProfileScoring(makeProfile('mini-program')).disabledDimensions).toBeUndefined();
  });

  it('backend 类型不剔除任何维度（向后兼容）', () => {
    expect(resolveProfileScoring(makeProfile('backend')).disabledDimensions).toBeUndefined();
  });
});

describe('applyDisabledDimensions — 权重剔除与归一化', () => {
  it('被剔维度权重置 0，其余维度归一化到和为 1', () => {
    const base = {
      quality: 0.35,
      security: 0.25,
      dependencies: 0.15,
      techdebt: 0.15,
      gate: 0.1,
    };
    const result = applyDisabledDimensions(base, ['gate']);
    expect(result.gate).toBe(0);
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
    expect(result.security).toBeCloseTo(0.25 / 0.9, 3);
  });

  it('无剔除时返回原对象', () => {
    const base = { security: 0.5 };
    expect(applyDisabledDimensions(base, undefined)).toBe(base);
  });
});

describe('buildHealthDimensions — 维度适用性端到端', () => {
  it('mini-program 全部 7 维权重 > 0，且权重和仍为 1', () => {
    const dims = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      profile: makeProfile('mini-program'),
    });
    for (const d of dims) {
      expect(d.weight).toBeGreaterThan(0);
    }
    const sum = dims.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.02);
  });

  it('同份带 architecture 问题的报告：mini-program 整体分 < backend（architecture 并入 quality 且 mini-program 质量升权）', () => {
    const inspect = { issues: [{ severity: 'error' as const, category: 'architecture' }] };
    const mini = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard: emptyGuard, inspect, profile: makeProfile('mini-program') }),
    );
    const backend = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard: emptyGuard, inspect, profile: makeProfile('backend') }),
    );
    expect(mini.overall).toBeLessThan(backend.overall);
  });

  it('无 issue 时 mini-program 整体分近满分（剔除维度不影响满分）', () => {
    const r = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard: emptyGuard, inspect: emptyInspect, profile: makeProfile('mini-program') }),
    );
    expect(r.overall).toBeGreaterThanOrEqual(99);
  });
});
