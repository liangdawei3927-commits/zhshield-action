import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { resolveProfileScoring, applyWeightDeltas } from '../profile-scoring-resolver';
import type { ScoringProjectProfile } from '@zh/fingerprint';

/** 构造最小测试画像 */
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

describe('resolveProfileScoring — 画像驱动权重解析', () => {
  it('无 profile 时返回空覆盖（向后兼容）', () => {
    expect(resolveProfileScoring(undefined)).toEqual({});
    expect(resolveProfileScoring(null)).toEqual({});
  });

  it('unknown 类型返回空覆盖', () => {
    expect(resolveProfileScoring(makeProfile('unknown'))).toEqual({});
  });

  it('backend 类型返回空覆盖（用默认权重）', () => {
    expect(resolveProfileScoring(makeProfile('backend'))).toEqual({});
  });

  it('frontend 类型降低 security 权重、提升 quality', () => {
    const overrides = resolveProfileScoring(makeProfile('frontend'));
    expect(overrides.weightDeltas).toBeDefined();
    expect(overrides.weightDeltas!.security).toBeLessThan(0);
    expect(overrides.weightDeltas!.quality).toBeGreaterThan(0);
  });

  it('mini-program 类型降低 dependencies、提升 quality', () => {
    const overrides = resolveProfileScoring(makeProfile('mini-program'));
    expect(overrides.weightDeltas!.dependencies).toBeLessThan(0);
    expect(overrides.weightDeltas!.quality).toBeGreaterThan(0);
  });

  it('desktop 类型提升 security、降低 documentation', () => {
    const overrides = resolveProfileScoring(makeProfile('desktop'));
    expect(overrides.weightDeltas!.security).toBeGreaterThan(0);
    expect(overrides.weightDeltas!.documentation).toBeLessThan(0);
  });
});

describe('applyWeightDeltas — 权重归一化', () => {
  it('应用增量后权重和仍为 1', () => {
    const base = { security: 0.35, quality: 0.25, architecture: 0.20, dependencies: 0.15, documentation: 0.05 };
    const deltas = { security: -0.10, quality: +0.10 };
    const result = applyWeightDeltas(base, deltas);
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
  });

  it('无增量时返回原对象', () => {
    const base = { security: 0.35 };
    expect(applyWeightDeltas(base, undefined)).toBe(base);
  });
});

describe('buildHealthDimensions — 画像驱动评分', () => {
  it('不传 profile 时向后兼容（默认权重）', () => {
    const dims = buildHealthDimensions(emptyGuard, emptyInspect);
    const securityDim = dims.find((d) => d.name === 'security');
    expect(securityDim?.weight).toBeCloseTo(0.35, 1);
  });

  it('frontend profile 降低 security 维度权重', () => {
    const profile = makeProfile('frontend');
    const dimsDefault = buildHealthDimensions(emptyGuard, emptyInspect);
    const dimsProfiled = buildHealthDimensions(emptyGuard, emptyInspect, undefined, profile);

    const defaultSecurity = dimsDefault.find((d) => d.name === 'security')!.weight;
    const profiledSecurity = dimsProfiled.find((d) => d.name === 'security')!.weight;
    expect(profiledSecurity).toBeLessThan(defaultSecurity);
  });

  it('mini-program profile 降低 dependencies 维度权重', () => {
    const profile = makeProfile('mini-program');
    const dimsDefault = buildHealthDimensions(emptyGuard, emptyInspect);
    const dimsProfiled = buildHealthDimensions(emptyGuard, emptyInspect, undefined, profile);

    const defaultDeps = dimsDefault.find((d) => d.name === 'dependencies')!.weight;
    const profiledDeps = dimsProfiled.find((d) => d.name === 'dependencies')!.weight;
    expect(profiledDeps).toBeLessThan(defaultDeps);
  });

  it('backend profile 与默认权重一致', () => {
    const profile = makeProfile('backend');
    const dimsDefault = buildHealthDimensions(emptyGuard, emptyInspect);
    const dimsProfiled = buildHealthDimensions(emptyGuard, emptyInspect, undefined, profile);

    for (let i = 0; i < dimsDefault.length; i++) {
      expect(dimsProfiled[i].weight).toBeCloseTo(dimsDefault[i].weight, 2);
    }
  });

  it('所有维度权重和为 1（任意 profile）', () => {
    for (const type of ['backend', 'frontend', 'app', 'mini-program', 'desktop', 'library', 'cli'] as const) {
      const dims = buildHealthDimensions(emptyGuard, emptyInspect, undefined, makeProfile(type));
      const sum = dims.reduce((s, d) => s + d.weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.02);
    }
  });
});
