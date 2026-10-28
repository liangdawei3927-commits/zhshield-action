import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SopSyncCoordinator } from '../sop/cache/sop-sync-coordinator';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 云端同步准入校验回归集。
 *
 * `SopSyncCoordinator` 原先对三类入口（缓存恢复 / 增量 diff / 全量替换）一律裸
 * `registry.loadAll` / `registry.register`，字段全靠类型断言 —— 云端下发
 * `status: "actived"` 会让规则进 registry 却永不匹配 `getActive()`，
 * 且**被写进本地缓存**，下次启动继续带着脏数据。这里锁住「拒收 + 不持久化坏规则」。
 */

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造只关心「规则准入」的最小协调器：其余依赖用哑实现 */
function makeCoordinator(cached: SopRule[], fetched: SopRule[] = []) {
  const registry = new SopRegistry();
  const persisted: SopRule[][] = [];

  const coordinator = new SopSyncCoordinator({
    registry,
    clientVersion: '1.0.0',
    sqliteStore: {
      loadAll: () => cached,
      persist: (rules: SopRule[]) => {
        persisted.push(rules);
      },
    } as never,
    versionStore: {
      load: async () => null,
      loadSyncState: async () => null,
      save: async () => {},
      saveSyncState: async () => {},
      logSync: async () => {},
    } as never,
    // 返回值形状必须与真实契约一致（SopFetchResult）：裸数组会让 fullSync 走进失败分支
    syncClient: { fetchFull: async () => ({ ok: true, data: fetched }) } as never,
    scheduler: {
      hydrate: () => {},
      recordSync: () => {},
      recordSyncFailure: () => {},
      getState: () => ({}),
      isOnline: true,
    } as never,
  });

  return { coordinator, registry, persisted };
}

describe('SopSyncCoordinator — 云端规则准入', () => {
  it('initialize 从缓存恢复时拒收 status 非法的规则', async () => {
    const { coordinator, registry } = makeCoordinator([
      makeRule({ id: 'cache.good' }),
      makeRule({ id: 'cache.bad', status: 'actived' as never }),
    ]);

    await coordinator.initialize();

    expect(registry.get('cache.good')).toBeDefined();
    expect(registry.get('cache.bad')).toBeUndefined();
    expect(registry.getActive().map((r) => r.id)).toEqual(['cache.good']);
    expect(coordinator.admission.getIssues()[0]).toMatchObject({
      file: 'cloud-sync:cache.bad',
      field: 'status',
      level: 'fatal',
    });
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('cache.bad');
  });

  it('emergencyUpdate 只把合法规则写进缓存（坏规则不落盘）', async () => {
    const { coordinator, registry, persisted } = makeCoordinator([]);

    await coordinator.emergencyUpdate([
      makeRule({ id: 'em.good' }),
      makeRule({ id: 'em.bad', domain: 'gurad' as never }),
    ]);

    expect(registry.get('em.good')).toBeDefined();
    expect(registry.get('em.bad')).toBeUndefined();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.map((r) => r.id)).toEqual(['em.good']);
  });

  it('tags 非数组的云端规则仍被接纳，但归一化为空数组', async () => {
    const { coordinator, registry } = makeCoordinator([]);

    await coordinator.emergencyUpdate([makeRule({ id: 'em.tags', tags: 'oops' as never })]);

    expect(registry.get('em.tags')?.tags).toEqual([]);
    expect(coordinator.admission.getIssues()[0]).toMatchObject({ field: 'tags', level: 'warn' });
    expect(warnSpy).toHaveBeenCalled();
  });
});
