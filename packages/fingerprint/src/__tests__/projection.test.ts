import { describe, expect, it } from 'vitest';
import { toFeature, toFeatureFromProfile } from '../projection';
import type { ProjectProfile, MatchResult, Signal } from '../types';

function emptySignal(): Signal {
  return { ruleId: 'test', kind: 'manifest', file: 'test', weight: 1.0, payload: {} };
}

function matchValue<T>(value: T): MatchResult<T> {
  return { value, confidence: 1.0, signals: [emptySignal()] };
}

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1,
    architecture: matchValue('monolith'),
    targets: [],
    environments: [],
    dependencies: { direct: [] },
    detectedAt: '2026-01-01T00:00:00Z',
    stale: false,
    signals: [],
    overrides: {},
    ...overrides,
  };
}

describe('toFeature', () => {
  describe('空 profile', () => {
    it('GIVEN profile 无 targets WHEN toFeature THEN 返回空 features', () => {
      const profile = makeProfile({ targets: [] });
      const result = toFeature(profile);
      expect(result.language).toBeUndefined();
      expect(result.framework).toBeUndefined();
      expect(result.features).toEqual([]);
    });
  });

  describe('单 target 映射', () => {
    it('GIVEN 单 target 含 language=typescript WHEN toFeature THEN language 映射正确', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [],
            routeKey: 'typescript::',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.language).toBe('typescript');
      expect(result.framework).toBeUndefined();
    });

    it('GIVEN language=unknown WHEN toFeature THEN language 为 undefined', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('unknown'),
            frameworks: [],
            routeKey: 'unknown::',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.language).toBeUndefined();
    });

    it('GIVEN framework=NestJS WHEN toFeature THEN framework 映射正确', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [matchValue('NestJS')],
            routeKey: 'typescript:nestjs:',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.framework).toBe('NestJS');
    });
  });

  describe('多 frameworks → 取第一个', () => {
    it('GIVEN 多个 frameworks WHEN toFeature THEN 取第一个 framework', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [matchValue('React'), matchValue('Vite')],
            routeKey: 'typescript:react:',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.framework).toBe('React');
      expect(result.features).not.toContain('Vite');
    });
  });

  describe('features 聚合', () => {
    it('GIVEN productForm=backend WHEN toFeature THEN features 包含 backend', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('python'),
            frameworks: [matchValue('FastAPI')],
            productForm: matchValue('backend'),
            routeKey: 'python:fastapi:backend',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.features).toContain('backend');
    });

    it('GIVEN architecture=modular-monolith WHEN toFeature THEN features 包含 architecture', () => {
      const profile = makeProfile({
        architecture: matchValue('modular-monolith'),
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [],
            routeKey: 'typescript::',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.features).toContain('modular-monolith');
    });

    it('GIVEN architecture=unknown WHEN toFeature THEN features 不包含 unknown', () => {
      const profile = makeProfile({
        architecture: matchValue('unknown'),
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [],
            routeKey: 'typescript::',
          },
        ],
      });
      const result = toFeature(profile);
      expect(result.features).not.toContain('unknown');
    });

    it('GIVEN environments 含 production WHEN toFeature THEN features 包含 production', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [],
            routeKey: 'typescript::',
          },
        ],
        environments: [matchValue('production'), matchValue('node')],
      });
      const result = toFeature(profile);
      expect(result.features).toContain('production');
      expect(result.features).toContain('node');
    });

    it('GIVEN 完整 profile WHEN toFeature THEN features 包含所有聚合维度', () => {
      const profile = makeProfile({
        architecture: matchValue('modular-monolith'),
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('typescript'),
            frameworks: [matchValue('NestJS')],
            productForm: matchValue('backend'),
            routeKey: 'typescript:nestjs:backend',
          },
        ],
        environments: [matchValue('node')],
      });
      const result = toFeature(profile);
      expect(result.language).toBe('typescript');
      expect(result.framework).toBe('NestJS');
      expect(result.features).toEqual(['backend', 'modular-monolith', 'node']);
    });
  });

  describe('纯函数保证', () => {
    it('GIVEN 任何 profile WHEN toFeature 调用两次 THEN 返回相同结构', () => {
      const profile = makeProfile({
        targets: [
          {
            id: 'default',
            path: '.',
            language: matchValue('go'),
            frameworks: [matchValue('gin')],
            productForm: matchValue('backend'),
            routeKey: 'go:gin:backend',
          },
        ],
      });
      const first = toFeature(profile);
      const second = toFeature(profile);
      expect(first).toEqual(second);
    });
  });
});

describe('toFeatureFromProfile', () => {
  it('GIVEN typescript+NestJS+hasTypeScript WHEN 投影 THEN 返回完整 feature 结构', () => {
    const result = toFeatureFromProfile({
      language: 'typescript',
      framework: 'NestJS',
      hasTypeScript: true,
    });
    expect(result.language).toBe('typescript');
    expect(result.framework).toBe('NestJS');
    expect(result.features).toEqual(['typescript', 'typescript', 'NestJS']);
  });

  it('GIVEN language=unknown WHEN 投影 THEN 顶层 language 未设且 features 不含 unknown', () => {
    const result = toFeatureFromProfile({
      language: 'unknown',
      framework: 'Express',
      hasTypeScript: false,
    });
    expect(result.language).toBeUndefined();
    expect(result.framework).toBe('Express');
    expect(result.features).toEqual(['Express']);
  });

  it('GIVEN 无 framework 且非 TS WHEN 投影 THEN 仅保留 language feature', () => {
    const result = toFeatureFromProfile({
      language: 'python',
      framework: null,
      hasTypeScript: false,
    });
    expect(result.language).toBe('python');
    expect(result.framework).toBeUndefined();
    expect(result.features).toEqual(['python']);
  });

  it('GIVEN TS 但 language=unknown WHEN 投影 THEN 仅含 typescript feature', () => {
    const result = toFeatureFromProfile({
      language: 'unknown',
      framework: null,
      hasTypeScript: true,
    });
    expect(result.language).toBeUndefined();
    expect(result.features).toEqual(['typescript']);
  });

  it('GIVEN 空语义（unknown+无framework+非TS）WHEN 投影 THEN 返回空 features', () => {
    const result = toFeatureFromProfile({
      language: 'unknown',
      framework: null,
      hasTypeScript: false,
    });
    expect(result.language).toBeUndefined();
    expect(result.framework).toBeUndefined();
    expect(result.features).toEqual([]);
  });

  it('GIVEN 任何输入 WHEN 调用两次 THEN 纯函数返回相同结构', () => {
    const input = { language: 'typescript', framework: 'React', hasTypeScript: true };
    expect(toFeatureFromProfile(input)).toEqual(toFeatureFromProfile(input));
  });
});
