import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SopPredictiveLoader } from '../sop/cache/sop-predictive-loader';
import type { SopCacheManager } from '../sop/cache/sop-cache-manager';
import type { SopLazyLoader } from '../sop/cache/sop-lazy-loader';
import type { SyncResult } from '../sop/_meta/sop-types';

/** 构造 mock SopCacheManager，可控的 syncFromCloud + getLazyLoader */
function makeCacheManagerMock(
  opts: {
    syncResult?: SyncResult;
    lazyLoader?: SopLazyLoader;
  } = {},
) {
  const syncFromCloud = vi.fn().mockResolvedValue(opts.syncResult ?? { updated: false });
  return {
    syncFromCloud,
    getLazyLoader: vi.fn(() => opts.lazyLoader ?? null),
  } as unknown as SopCacheManager;
}

function makeLazyLoaderMock() {
  return {
    syncForProject: vi.fn().mockResolvedValue(['security', 'quality']),
  } as unknown as SopLazyLoader;
}

describe('SopPredictiveLoader', () => {
  let cacheManager: SopCacheManager;
  let lazyLoader: SopLazyLoader;

  beforeEach(() => {
    lazyLoader = makeLazyLoaderMock();
    cacheManager = makeCacheManagerMock({ lazyLoader });
  });

  // ─── 活跃时段跳过 ─────────────────────────────────
  describe('活跃时段跳过', () => {
    afterEach(() => vi.useRealTimers());

    it('当前小时属于 activeHours 应跳过预加载', async () => {
      vi.setSystemTime(new Date('2026-08-01T10:00:00Z')); // 10点（UTC，getHours 取本地时区，这里仅作相对测试）
      const currentHour = new Date().getHours();
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [currentHour], // 当前小时标记为活跃
        projectHistory: [],
      });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('active_hours');
      expect(result.preloadedModules).toEqual([]);
      // 活跃时段不应触发云同步
      expect(cacheManager.syncFromCloud).not.toHaveBeenCalled();
    });

    it('当前小时不属于 activeHours 应执行预加载', async () => {
      vi.setSystemTime(new Date('2026-08-01T10:00:00Z'));
      const currentHour = new Date().getHours();
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [currentHour === 0 ? 1 : 0], // 排除当前小时
        currentProjectType: 'nestjs',
        projectHistory: [],
      });
      expect(result.skipped).toBe(false);
      expect(cacheManager.syncFromCloud).toHaveBeenCalled();
    });
  });

  // ─── 增量更新记录 ─────────────────────────────────
  describe('增量更新记录', () => {
    it('syncFromCloud 返回 updated=true 应记录 *incremental-update', async () => {
      cacheManager = makeCacheManagerMock({
        syncResult: { updated: true, fromVersion: '1.0.0', toVersion: '2.0.0' },
        lazyLoader,
      });
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [], // 非活跃
        currentProjectType: 'nestjs',
        projectHistory: [],
      });
      expect(result.preloadedModules).toContain('*incremental-update');
    });

    it('syncFromCloud 返回 updated=false 不应记录增量更新', async () => {
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [],
        currentProjectType: 'nestjs',
        projectHistory: [],
      });
      expect(result.preloadedModules).not.toContain('*incremental-update');
    });
  });

  // ─── 项目类型预测 ─────────────────────────────────
  describe('项目类型预测', () => {
    it('无 currentProjectType 时不应调用 lazyLoader.syncForProject', async () => {
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [],
        projectHistory: [],
      });
      expect(lazyLoader.syncForProject).not.toHaveBeenCalled();
      expect(result.skipped).toBe(false);
    });

    it('currentProjectType=nestjs 应触发 lazyLoader 预加载', async () => {
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [],
        currentProjectType: 'nestjs',
        projectHistory: [],
      });
      expect(lazyLoader.syncForProject).toHaveBeenCalled();
      // syncForProject mock 返回 ['security','quality']，应并入结果
      expect(result.preloadedModules).toContain('security');
      expect(result.preloadedModules).toContain('quality');
    });

    it('无 lazyLoader（undefined）时即使有 currentProjectType 也不应报错', async () => {
      cacheManager = makeCacheManagerMock({
        syncResult: { updated: false },
        lazyLoader: undefined,
      });
      const loader = new SopPredictiveLoader(cacheManager);
      const result = await loader.preloadStrategy({
        userId: 'u-1',
        activeHours: [],
        currentProjectType: 'nestjs',
        projectHistory: [],
      });
      expect(result.skipped).toBe(false);
      // 无 lazyLoader，preloadedModules 只可能有 *incremental-update
      expect(
        result.preloadedModules.every((m) => m === '*incremental-update' || !m.startsWith('*')),
      ).toBe(true);
    });
  });

  // ─── 预测模块去重 ─────────────────────────────────
  describe('预测模块去重', () => {
    it('重复预测的模块应去重（Set 语义）', async () => {
      const loader = new SopPredictiveLoader(cacheManager);
      // nestjs + 5-7点时段都会预测 security，但 syncForProject mock 已统一返回
      vi.setSystemTime(new Date('2026-08-01T06:00:00Z')); // 6点（预测 security）
      const hour = new Date().getHours();
      if (hour >= 5 && hour <= 7) {
        const result = await loader.preloadStrategy({
          userId: 'u-1',
          activeHours: [],
          currentProjectType: 'nestjs',
          projectHistory: [],
        });
        // syncForProject 返回 ['security','quality']，应只出现一次
        const secCount = result.preloadedModules.filter((m) => m === 'security').length;
        expect(secCount).toBe(1);
      }
      vi.useRealTimers();
    });
  });
});
