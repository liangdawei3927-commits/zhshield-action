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
  it('cli 类型剔除 architecture 维度', () => {
    expect(resolveProfileScoring(makeProfile('cli')).disabledDimensions).toContain('architecture');
  });

  it('mini-program 类型剔除 architecture 维度', () => {
    expect(resolveProfileScoring(makeProfile('mini-program')).disabledDimensions).toContain('architecture');
  });

  it('backend 类型不剔除任何维度（向后兼容）', () => {
    expect(resolveProfileScoring(makeProfile('backend')).disabledDimensions).toBeUndefined();
  });
});

describe('applyDisabledDimensions — 权重剔除与归一化', () => {
  it('被剔维度权重置 0，其余维度归一化到和为 1', () => {
    const base = { security: 0.35, quality: 0.25, architecture: 0.20, dependencies: 0.15, documentation: 0.05 };
    const result = applyDisabledDimensions(base, ['architecture']);
    expect(result.architecture).toBe(0);
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
    expect(result.security).toBeCloseTo(0.35 / 0.8, 3);
  });

  it('无剔除时返回原对象', () => {
    const base = { security: 0.5 };
    expect(applyDisabledDimensions(base, undefined)).toBe(base);
  });
});

describe('buildHealthDimensions — 维度适用性端到端', () => {
  it('mini-program 的 architecture 维度权重为 0，且其余权重和仍为 1', () => {
    const dims = buildHealthDimensions(emptyGuard, emptyInspect, undefined, makeProfile('mini-program'));
    expect(dims.find((d) => d.name === 'architecture')!.weight).toBe(0);
    const sum = dims.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.02);
  });

  it('同份带 architecture 问题的报告：mini-program 整体分 > backend（architecture 不计入）', () => {
    const inspect = { issues: [{ severity: 'error' as const, category: 'architecture' }] };
    const mini = new ScoringEngine().calculate('p', buildHealthDimensions(emptyGuard, inspect, undefined, makeProfile('mini-program')));
    const backend = new ScoringEngine().calculate('p', buildHealthDimensions(emptyGuard, inspect, undefined, makeProfile('backend')));
    expect(mini.overall).toBeGreaterThan(backend.overall);
  });

  it('无 issue 时 mini-program 整体分近满分（剔除维度不影响满分）', () => {
    const r = new ScoringEngine().calculate('p', buildHealthDimensions(emptyGuard, emptyInspect, undefined, makeProfile('mini-program')));
    expect(r.overall).toBeGreaterThanOrEqual(99);
  });
});
