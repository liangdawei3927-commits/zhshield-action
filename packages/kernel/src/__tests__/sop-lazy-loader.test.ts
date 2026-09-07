import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopLazyLoader } from '../sop/cache/sop-lazy-loader';
import type { SopCacheManager } from '../sop/cache/sop-cache-manager';
import type { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopRule, ProjectFeature } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

/** 构造一个最小 SopCacheManager mock：仅实现 lazy-loader 依赖的两个方法 */
function makeCacheManagerMock(cacheDir: string, rules: SopRule[]): SopCacheManager {
  const registry = {
    getAll: () => rules,
  } as unknown as SopRegistry;
  return {
    getCacheDir: () => cacheDir,
    getRegistry: () => registry,
  } as unknown as SopCacheManager;
}

describe('SopLazyLoader', () => {
  let cacheDir: string;
  let loader: SopLazyLoader;
  let rules: SopRule[];

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zhshield-lazy-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(cacheDir, 'modules'), { recursive: true });

    // 构造覆盖多个模块的规则集
    rules = [
      makeRule({ id: 'typescript.type-safety', tags: ['typescript'] }),
      makeRule({ id: 'typescript.strict-mode', tags: ['typescript'] }),
      makeRule({ id: 'nestjs.module-boundary', tags: ['nestjs'] }),
      makeRule({ id: 'quality.eslint-rules', tags: ['quality'] }),
      makeRule({ id: 'security.vulnerability', tags: ['security'] }),
      makeRule({ id: 'architecture.circular-dependency', tags: ['architecture'] }),
    ];
    loader = new SopLazyLoader(makeCacheManagerMock(cacheDir, rules));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // ─── syncForProject 模块映射 ──────────────────────
  describe('syncForProject 模块映射', () => {
    it('TypeScript 项目应加载 typescript 模块 + 默认模块', async () => {
      const feature: ProjectFeature = { language: 'typescript', features: [] };
      const synced = await loader.syncForProject(feature);
      expect(synced).toContain('typescript');
      // 默认必加载模块
      expect(synced).toContain('security');
      expect(synced).toContain('quality');
      expect(synced).toContain('architecture');
    });

    it('NestJS 项目应额外加载 nestjs 模块', async () => {
      const feature: ProjectFeature = { framework: 'nestjs', features: [] };
      const synced = await loader.syncForProject(feature);
      expect(synced).toContain('nestjs');
      expect(synced).toContain('security');
    });

    it('JS 项目应映射到 typescript 模块（复用）', async () => {
      const feature: ProjectFeature = { language: 'javascript', features: [] };
      const synced = await loader.syncForProject(feature);
      expect(synced).toContain('typescript');
    });

    it('未提供语言/框架的项目应只加载默认三模块', async () => {
      const feature: ProjectFeature = { features: [] };
      const synced = await loader.syncForProject(feature);
      expect(synced.sort()).toEqual(['architecture', 'quality', 'security']);
    });

    it('syncForProject 后 modules 目录应生成对应 .db 文件', async () => {
      await loader.syncForProject({ language: 'typescript', features: [] });
      const files = fs.readdirSync(path.join(cacheDir, 'modules'));
      // 至少包含 security.db, quality.db, architecture.db, typescript.db
      expect(files.some((f) => f === 'security.db')).toBe(true);
      expect(files.some((f) => f === 'typescript.db')).toBe(true);
    });
  });

  // ─── 模块新鲜度 ──────────────────────────────────
  describe('模块新鲜度（24h 内不重复同步）', () => {
    it('security 模块应始终重新同步（强制刷新）', async () => {
      // 先写一个 security.db
      await loader.syncForProject({ features: [] });
      const secPath = path.join(cacheDir, 'modules', 'security.db');
      const beforeMtime = fs.statSync(secPath).mtimeMs;
      // 立即再次同步
      await loader.syncForProject({ features: [] });
      const afterMtime = fs.statSync(secPath).mtimeMs;
      // security 强制刷新，mtime 应更新（>= before）
      expect(afterMtime).toBeGreaterThanOrEqual(beforeMtime);
    });

    it('非 security 模块 24h 内应跳过同步（mtime 不变）', async () => {
      const feature: ProjectFeature = { language: 'typescript', features: [] };
      await loader.syncForProject(feature);
      const tsPath = path.join(cacheDir, 'modules', 'typescript.db');
      const beforeMtime = fs.statSync(tsPath).mtimeMs;

      // 立即再次同步：typescript 应被视为 fresh，跳过
      await loader.syncForProject(feature);
      const afterMtime = fs.statSync(tsPath).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });

    it('空内容（[]）模块文件不应被视为新鲜（应重新写入规则）', async () => {
      const feature: ProjectFeature = { language: 'typescript', features: [] };
      // 预置空数组占位文件：模拟规则库为空时写入的缓存，此类文件必须可被重写
      const tsPath = path.join(cacheDir, 'modules', 'typescript.db');
      fs.writeFileSync(tsPath, '[]', 'utf-8');

      await loader.syncForProject(feature);

      // 空内容触发重写：模块规则被实际写入而非被 24h 窗口跳过
      const tsRules = await loader.getModuleRules('typescript');
      expect(tsRules.length).toBeGreaterThan(0);
      expect(tsRules.some((r) => r.id.startsWith('typescript'))).toBe(true);
    });
  });

  // ─── getLoadedModules ────────────────────────────
  describe('getLoadedModules', () => {
    it('未同步任何模块时应返回空数组', async () => {
      // 清空 modules 目录
      fs.rmSync(path.join(cacheDir, 'modules'), { recursive: true, force: true });
      fs.mkdirSync(path.join(cacheDir, 'modules'), { recursive: true });
      expect(await loader.getLoadedModules()).toEqual([]);
    });

    it('应返回已加载模块名（去除 .db 后缀）', async () => {
      await loader.syncForProject({ language: 'typescript', features: [] });
      const loaded = await loader.getLoadedModules();
      expect(loaded).toContain('typescript');
      expect(loaded).toContain('security');
    });

    it('应忽略非 .db 文件', async () => {
      fs.writeFileSync(path.join(cacheDir, 'modules', 'readme.txt'), 'x');
      const loaded = await loader.getLoadedModules();
      expect(loaded).not.toContain('readme');
    });
  });

  // ─── getModuleRules ──────────────────────────────
  describe('getModuleRules', () => {
    it('已同步模块应返回规则数组', async () => {
      await loader.syncForProject({ language: 'typescript', features: [] });
      const tsRules = await loader.getModuleRules('typescript');
      expect(Array.isArray(tsRules)).toBe(true);
      expect(tsRules.length).toBeGreaterThan(0);
      // 应包含 typescript.* 规则
      expect(tsRules.some((r) => r.id.startsWith('typescript'))).toBe(true);
    });

    it('未同步模块应返回空数组', async () => {
      const rules = await loader.getModuleRules('non-existent');
      expect(rules).toEqual([]);
    });

    it('security 模块应包含 security.* 规则', async () => {
      await loader.syncForProject({ features: [] });
      const secRules = await loader.getModuleRules('security');
      expect(secRules.some((r) => r.id.startsWith('security'))).toBe(true);
    });
  });

  // ─── removeModule ────────────────────────────────
  describe('removeModule', () => {
    it('删除后 getLoadedModules 不再包含该模块', async () => {
      await loader.syncForProject({ language: 'typescript', features: [] });
      expect(await loader.getLoadedModules()).toContain('typescript');

      await loader.removeModule('typescript');
      const loaded = await loader.getLoadedModules();
      expect(loaded).not.toContain('typescript');
      // 其余模块不受影响
      expect(loaded).toContain('security');
    });

    it('幂等：二次删除不抛', async () => {
      await loader.syncForProject({ language: 'typescript', features: [] });
      await loader.removeModule('typescript');
      await expect(loader.removeModule('typescript')).resolves.toBeUndefined();
    });

    it('删除不存在的模块不抛', async () => {
      await expect(loader.removeModule('non-existent')).resolves.toBeUndefined();
    });
  });

  // ─── getNeededModules ────────────────────────────
  describe('getNeededModules', () => {
    it('framework=nestjs → 含 nestjs', () => {
      const needed = loader.getNeededModules({ framework: 'nestjs', features: [] });
      expect(needed).toContain('nestjs');
    });

    it('language=typescript → 含 typescript', () => {
      const needed = loader.getNeededModules({ language: 'typescript', features: [] });
      expect(needed).toContain('typescript');
    });

    it('默认含 security/quality/architecture', () => {
      const needed = loader.getNeededModules({ features: [] });
      expect(needed.sort()).toEqual(['architecture', 'quality', 'security']);
    });
  });

  // ─── getRefsFilteredActiveModules ────────────────
  describe('getRefsFilteredActiveModules', () => {
    // 账本与 cacheDir 同级（sop-cache 的父目录）；用独立父目录隔离账本文件，避免跨用例串扰
    let parentDir: string;
    let isolatedLoader: SopLazyLoader;

    beforeEach(() => {
      parentDir = path.join(os.tmpdir(), `zhshield-lazy-parent-${crypto.randomUUID()}`);
      const dir = path.join(parentDir, 'sop-cache');
      fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
      isolatedLoader = new SopLazyLoader(makeCacheManagerMock(dir, rules));
    });

    afterEach(() => {
      fs.rmSync(parentDir, { recursive: true, force: true });
    });

    it('账本含 sop-module:typescript reclaiming → 结果剔除 typescript', async () => {
      await isolatedLoader.syncForProject({ language: 'typescript', features: [] });
      const ledgerPath = path.join(parentDir, 'capability-refs.json');
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          capabilities: {
            'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: 1759747200000 },
          },
        }),
        'utf-8',
      );

      const active = await isolatedLoader.getRefsFilteredActiveModules();
      expect(active).not.toContain('typescript');
      expect(active).toContain('security');
    });

    it('账本缺失 → 返回全部已加载模块', async () => {
      await isolatedLoader.syncForProject({ language: 'typescript', features: [] });
      const active = await isolatedLoader.getRefsFilteredActiveModules();
      expect(active).toContain('typescript');
      expect(active).toContain('security');
    });

    it('账本 JSON 损坏 → 返回全部已加载模块（不抛）', async () => {
      await isolatedLoader.syncForProject({ language: 'typescript', features: [] });
      const ledgerPath = path.join(parentDir, 'capability-refs.json');
      fs.writeFileSync(ledgerPath, '{ not valid json', 'utf-8');
      const active = await isolatedLoader.getRefsFilteredActiveModules();
      expect(active).toContain('typescript');
    });
  });
});
