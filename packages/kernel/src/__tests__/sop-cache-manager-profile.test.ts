import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import type { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopRule, ProjectFeature } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

function makeRegistryMock(rules: SopRule[]): SopRegistry {
  return { getAll: () => rules } as unknown as SopRegistry;
}

function makeProfileShape(overrides: {
  language?: string;
  framework?: string;
  productForm?: string;
  architecture?: string;
  environments?: string[];
} = {}) {
  return {
    schemaVersion: 1 as const,
    architecture: { value: overrides.architecture ?? 'monolith', confidence: 1.0, signals: [] },
    targets: [
      {
        id: 'default',
        path: '.',
        language: { value: overrides.language ?? 'typescript', confidence: 1.0, signals: [] },
        frameworks: overrides.framework
          ? [{ value: overrides.framework, confidence: 1.0, signals: [] }]
          : [],
        ...(overrides.productForm
          ? { productForm: { value: overrides.productForm, confidence: 1.0, signals: [] } }
          : {}),
        routeKey: `${overrides.language ?? 'typescript'}::`,
      },
    ],
    environments: (overrides.environments ?? []).map((e) => ({
      value: e,
      confidence: 1.0,
      signals: [],
    })),
  };
}

describe('SopCacheManager.syncForProject — ProjectProfile 接入', () => {
  let cacheDir: string;
  let manager: SopCacheManager;
  let rules: SopRule[];

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-profile-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(cacheDir, 'modules'), { recursive: true });

    rules = [
      makeRule({ id: 'typescript.type-safety', tags: ['typescript'] }),
      makeRule({ id: 'nestjs.module-boundary', tags: ['nestjs'] }),
      makeRule({ id: 'security.vulnerability', tags: ['security'] }),
      makeRule({ id: 'quality.eslint-rules', tags: ['quality'] }),
      makeRule({ id: 'architecture.circular-dependency', tags: ['architecture'] }),
    ];

    manager = new SopCacheManager(makeRegistryMock(rules), {
      cacheDir,
      lazyLoading: true,
    });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('传入 ProjectFeature（向后兼容）', () => {
    it('GIVEN 直接传 ProjectFeature WHEN syncForProject THEN 正常加载模块', async () => {
      const feature: ProjectFeature = { language: 'typescript', features: [] };
      await manager.syncForProject(feature);

      const loaded = getLoadedModules(cacheDir);
      expect(loaded).toContain('typescript');
      expect(loaded).toContain('security');
    });
  });

  describe('传入 ProjectProfile 结构化对象', () => {
    it('GIVEN profile 含 language=python WHEN syncForProject THEN 自动投影加载对应模块', async () => {
      const profile = makeProfileShape({ language: 'python' });
      await manager.syncForProject(profile);

      const loaded = getLoadedModules(cacheDir);
      expect(loaded).toContain('security');
      expect(loaded).toContain('quality');
    });

    it('GIVEN profile 含 framework=NestJS WHEN syncForProject THEN 自动投影加载 nestjs 模块', async () => {
      const profile = makeProfileShape({ framework: 'NestJS' });
      await manager.syncForProject(profile);

      const loaded = getLoadedModules(cacheDir);
      expect(loaded).toContain('nestjs');
      expect(loaded).toContain('security');
    });

    it('GIVEN profile 含 productForm WHEN syncForProject THEN 自动投影的 features 包含 productForm', async () => {
      const featureSpy: string[] = [];
      const original = manager.getLazyLoader();
      if (original) {
        const realSync = original.syncForProject.bind(original);
        (original as { syncForProject: typeof realSync }).syncForProject = async (
          f: ProjectFeature,
        ) => {
          featureSpy.push(...f.features);
          return realSync(f);
        };
      }

      const profile = makeProfileShape({ productForm: 'backend' });
      await manager.syncForProject(profile);

      expect(featureSpy).toContain('backend');
    });

    it('GIVEN 完整 profile WHEN syncForProject THEN 投影结果含 language + framework + features', async () => {
      let capturedFeature: ProjectFeature | undefined;
      const loader = manager.getLazyLoader();
      if (loader) {
        const realSync = loader.syncForProject.bind(loader);
        (loader as { syncForProject: typeof realSync }).syncForProject = async (
          f: ProjectFeature,
        ) => {
          capturedFeature = f;
          return realSync(f);
        };
      }

      const profile = makeProfileShape({
        language: 'typescript',
        framework: 'NestJS',
        productForm: 'backend',
        architecture: 'microservices',
        environments: ['node'],
      });
      await manager.syncForProject(profile);

      expect(capturedFeature).toBeDefined();
      expect(capturedFeature!.language).toBe('typescript');
      expect(capturedFeature!.framework).toBe('NestJS');
      expect(capturedFeature!.features).toContain('backend');
      expect(capturedFeature!.features).toContain('microservices');
      expect(capturedFeature!.features).toContain('node');
    });

    it('GIVEN 空 targets WHEN syncForProject THEN 投影结果 features 为空', async () => {
      let capturedFeature: ProjectFeature | undefined;
      const loader = manager.getLazyLoader();
      if (loader) {
        const realSync = loader.syncForProject.bind(loader);
        (loader as { syncForProject: typeof realSync }).syncForProject = async (
          f: ProjectFeature,
        ) => {
          capturedFeature = f;
          return realSync(f);
        };
      }

      const profile = {
        schemaVersion: 1 as const,
        architecture: { value: 'unknown' as const, confidence: 0, signals: [] },
        targets: [],
        environments: [],
        dependencies: { direct: [] },
        detectedAt: '2026-01-01T00:00:00Z',
        stale: false,
        signals: [],
        overrides: {},
      };
      await manager.syncForProject(profile);

      expect(capturedFeature).toBeDefined();
      expect(capturedFeature!.language).toBeUndefined();
      expect(capturedFeature!.framework).toBeUndefined();
      expect(capturedFeature!.features).toEqual([]);
    });
  });
});

function getLoadedModules(cacheDir: string): string[] {
  const modulesDir = path.join(cacheDir, 'modules');
  try {
    return fs
      .readdirSync(modulesDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.replace(/\.db$/, ''));
  } catch {
    return [];
  }
}
