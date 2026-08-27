// ProfileStore 单测：持久化 / overrides 合并 / 缓存

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProfileStore } from '../profile-store';
import type { ProjectProfile, UserOverrides } from '../types';

const JSON_FILE_RE = /\.json$/;

// ─── 测试辅助 ───

function makeTestProfile(overrides?: Partial<ProjectProfile>): ProjectProfile {
  return {
    schemaVersion: 1,
    architecture: { value: 'monolith', confidence: 0.8, signals: [] },
    targets: [
      {
        id: 'default',
        path: '/test/project',
        language: { value: 'typescript', confidence: 0.95, signals: [] },
        frameworks: [{ value: 'Next.js', confidence: 0.9, signals: [] }],
        routeKey: 'typescript:Next.js:*',
      },
    ],
    environments: [{ value: 'node', confidence: 1.0, signals: [] }],
    dependencies: { direct: [{ name: 'react', version: '^18.0.0' }] },
    detectedAt: '2026-08-17T00:00:00.000Z',
    stale: false,
    signals: [],
    overrides: {},
    ...overrides,
  };
}

// ─── 测试用例 ───

describe('ProfileStore', () => {
  let tempDir: string;
  let store: ProfileStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-store-test-'));
    store = new ProfileStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('持久化', () => {
    it('GIVEN 新画像 WHEN save THEN 文件被创建', () => {
      const projectPath = '/test/project';
      const profile = makeTestProfile();

      store.save(projectPath, profile);

      // 检查文件是否存在
      const files = fs.readdirSync(tempDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(JSON_FILE_RE);
    });

    it('GIVEN 已保存画像 WHEN load THEN 返回相同画像', () => {
      const projectPath = '/test/project';
      const profile = makeTestProfile();

      store.save(projectPath, profile);
      const loaded = store.load(projectPath);

      expect(loaded).toBeDefined();
      expect(loaded?.schemaVersion).toBe(1);
      expect(loaded?.architecture.value).toBe('monolith');
      expect(loaded?.targets[0].language.value).toBe('typescript');
    });

    it('GIVEN 未保存画像 WHEN load THEN 返回 undefined', () => {
      const loaded = store.load('/nonexistent/project');
      expect(loaded).toBeUndefined();
    });

    it('GIVEN 已保存画像 WHEN exists THEN 返回 true', () => {
      const projectPath = '/test/project';
      store.save(projectPath, makeTestProfile());

      expect(store.exists(projectPath)).toBe(true);
    });

    it('GIVEN 未保存画像 WHEN exists THEN 返回 false', () => {
      expect(store.exists('/nonexistent/project')).toBe(false);
    });

    it('GIVEN 已保存画像 WHEN delete THEN 文件被删除', () => {
      const projectPath = '/test/project';
      store.save(projectPath, makeTestProfile());

      expect(store.exists(projectPath)).toBe(true);

      store.delete(projectPath);

      expect(store.exists(projectPath)).toBe(false);
    });
  });

  describe('缓存', () => {
    it('GIVEN 已保存画像 WHEN 连续 load 两次 THEN 第二次从缓存读取', () => {
      const projectPath = '/test/project';
      store.save(projectPath, makeTestProfile());

      // 第一次 load
      const loaded1 = store.load(projectPath);
      // 第二次 load（应该从缓存读取）
      const loaded2 = store.load(projectPath);

      expect(loaded1).toBeDefined();
      expect(loaded2).toBeDefined();
      // 缓存命中时返回相同的引用
      expect(loaded1).toBe(loaded2);
    });

    it('GIVEN 清除缓存 WHEN load THEN 从文件系统重新读取', () => {
      const projectPath = '/test/project';
      store.save(projectPath, makeTestProfile());

      // 第一次 load
      const loaded1 = store.load(projectPath);

      // 清除缓存
      store.clearCache();

      // 第二次 load（应该从文件系统重新读取）
      const loaded2 = store.load(projectPath);

      expect(loaded1).toBeDefined();
      expect(loaded2).toBeDefined();
      // 清除缓存后返回新的引用
      expect(loaded1).not.toBe(loaded2);
      // 但内容相同
      expect(loaded1?.architecture.value).toBe(loaded2?.architecture.value);
    });
  });

  describe('overrides 合并', () => {
    it('GIVEN 新 overrides WHEN mergeOverridesAndSave THEN 创建新画像', () => {
      const projectPath = '/test/project';
      const overrides: UserOverrides = {
        architecture: 'microservices',
      };

      const result = store.mergeOverridesAndSave(projectPath, overrides);

      expect(result.schemaVersion).toBe(1);
      expect(result.overrides.architecture).toBe('microservices');
      expect(result.lastConfirmedAt).toBeDefined();
      expect(result.stale).toBe(false);
    });

    it('GIVEN 已有画像 + 新 overrides WHEN mergeOverridesAndSave THEN 合并到已有画像', () => {
      const projectPath = '/test/project';
      const existingProfile = makeTestProfile({
        overrides: {
          architecture: 'monolith',
        },
      });

      store.save(projectPath, existingProfile);

      const newOverrides: UserOverrides = {
        targets: {
          default: {
            language: 'python',
            productForm: 'backend',
          },
        },
      };

      const result = store.mergeOverridesAndSave(projectPath, newOverrides);

      // 合并后的 overrides 应该包含两者
      expect(result.overrides.architecture).toBe('monolith');
      expect(result.overrides.targets?.default.language).toBe('python');
      expect(result.overrides.targets?.default.productForm).toBe('backend');
    });

    it('GIVEN 已有画像 + overrides WHEN mergeOverridesAndSave THEN stale 被重置为 false', () => {
      const projectPath = '/test/project';
      const existingProfile = makeTestProfile({
        stale: true,
        overrides: {},
      });

      store.save(projectPath, existingProfile);

      const result = store.mergeOverridesAndSave(projectPath, {
        architecture: 'microservices',
      });

      expect(result.stale).toBe(false);
    });
  });

  describe('listAll', () => {
    it('GIVEN 多个已保存画像 WHEN listAll THEN 返回所有画像', () => {
      store.save('/project1', makeTestProfile());
      store.save('/project2', makeTestProfile());

      const all = store.listAll();

      expect(all.size).toBe(2);
    });

    it('GIVEN 空目录 WHEN listAll THEN 返回空映射', () => {
      const all = store.listAll();
      expect(all.size).toBe(0);
    });
  });

  describe('eventBus 事件发射', () => {
    it('GIVEN 提供 eventBus WHEN mergeOverridesAndSave 新画像 THEN emit profile:confirmed', () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const fakeBus = {
        emit(event: string, data: unknown): void {
          emitted.push({ event, data });
        },
      };

      const storeWithBus = new ProfileStore(tempDir, fakeBus);
      const overrides: UserOverrides = { architecture: 'microservices' };

      const result = storeWithBus.mergeOverridesAndSave('/test/project', overrides);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('profile:confirmed');
      const payload = emitted[0].data as { projectPath: string; profile: ProjectProfile };
      expect(payload.projectPath).toBe('/test/project');
      expect(payload.profile.overrides.architecture).toBe('microservices');
      expect(payload.profile).toBe(result);
    });

    it('GIVEN 提供 eventBus WHEN mergeOverridesAndSave 已有画像 THEN emit profile:confirmed', () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const fakeBus = {
        emit(event: string, data: unknown): void {
          emitted.push({ event, data });
        },
      };

      const storeWithBus = new ProfileStore(tempDir, fakeBus);
      storeWithBus.save('/test/project', makeTestProfile({ overrides: { architecture: 'monolith' } }));

      const result = storeWithBus.mergeOverridesAndSave('/test/project', {
        targets: { default: { language: 'python', productForm: 'backend' } },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('profile:confirmed');
      const payload = emitted[0].data as { projectPath: string; profile: ProjectProfile };
      expect(payload.profile.overrides.architecture).toBe('monolith');
      expect(payload.profile.overrides.targets?.default.language).toBe('python');
      expect(payload.profile).toBe(result);
    });

    it('GIVEN 未提供 eventBus WHEN mergeOverridesAndSave THEN 不报错', () => {
      const result = store.mergeOverridesAndSave('/test/project', { architecture: 'microservices' });

      expect(result.schemaVersion).toBe(1);
      expect(result.overrides.architecture).toBe('microservices');
    });
  });

  describe('schema 版本验证', () => {
    it('GIVEN schemaVersion != 1 WHEN load THEN 返回 undefined', () => {
      const projectPath = '/test/project';
      const invalidProfile = makeTestProfile({ schemaVersion: 2 });

      // 直接写入文件（绕过 save 的验证）
      const filePath = path.join(tempDir, `${store['normalizeKey'](projectPath)}.json`);
      fs.writeFileSync(filePath, JSON.stringify(invalidProfile), 'utf-8');

      const loaded = store.load(projectPath);
      expect(loaded).toBeUndefined();
    });
  });
});
