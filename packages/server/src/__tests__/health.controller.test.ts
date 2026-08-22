import { describe, it, expect, beforeEach } from 'vitest';
import { HealthController } from '../health.controller';
import type { SopService } from '../sop/sop.service';

interface FakeCacheManager {
  loadRules(module: string): Promise<unknown[]>;
  getLocalVersion(): Promise<{ version: string } | null>;
  getSyncHealthLevel(): 0 | 1 | 2 | 3 | 4;
}

function makeSopStub(overrides: Partial<{ rules: unknown[]; level: 0 | 1 | 2 | 3 | 4; cache: FakeCacheManager }> = {}): SopService {
  const cache: FakeCacheManager =
    overrides.cache ??
    {
      loadRules: async () => [{ id: 'guard.x' }],
      getLocalVersion: async () => ({ version: '1.2026.08.20.001' }),
      getSyncHealthLevel: () => overrides.level ?? 0,
    };
  return {
    getAllRules: () => overrides.rules ?? [{}],
    getCacheManager: () => cache,
  } as unknown as SopService;
}

describe('HealthController', () => {
  let controller: HealthController;

  describe('live()', () => {
    it('should return alive status', () => {
      controller = new HealthController();
      const result = controller.live();
      expect(result.status).toBe('alive');
    });
  });

  describe('health() — 全部组件健康', () => {
    beforeEach(() => {
      controller = new HealthController(makeSopStub());
    });

    it('返回 ok 状态、运行时间、版本与各组件实时数据', async () => {
      const result = await controller.health();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.version).toBe('0.2.0');
      expect(result.subsystems.database.status).toBe('ok');
      expect(result.subsystems.sopRules.detail).toContain('1 rules registered');
      expect(result.subsystems.sopCache.detail).toContain('1.2026.08.20.001');
    });
  });

  describe('health() — 组件故障降级', () => {
    it('规则注册表为空 → 整体 degraded，其余组件仍 ok，且不抛出', async () => {
      controller = new HealthController(makeSopStub({ rules: [] }));

      const result = await controller.health();

      expect(result.status).toBe('degraded');
      expect(result.subsystems.sopRules.status).toBe('degraded');
      expect(result.subsystems.database.status).toBe('ok');
    });

    it('同步严重过期（Level 4）→ syncHealth degraded 且整体 degraded', async () => {
      controller = new HealthController(makeSopStub({ level: 4 }));

      const result = await controller.health();

      expect(result.subsystems.syncHealth.status).toBe('degraded');
      expect(result.subsystems.syncHealth.detail).toContain('level 4');
      expect(result.status).toBe('degraded');
    });

    it('依赖探测抛错（sqlite 崩溃）→ 该组件 degraded，端点正常返回', async () => {
      const brokenCache: FakeCacheManager = {
        loadRules: async () => {
          throw new Error('SQLITE_CORRUPT');
        },
        getLocalVersion: async () => null,
        getSyncHealthLevel: () => 0,
      };
      controller = new HealthController(makeSopStub({ cache: brokenCache }));

      const result = await controller.health();

      expect(result.subsystems.database.status).toBe('degraded');
      expect(result.subsystems.database.detail).toContain('SQLITE_CORRUPT');
      expect(result.status).toBe('degraded');
    });

    it('依赖挂起超过 500ms → 按超时降级且端点在有界时间内返回', async () => {
      const hangingCache: FakeCacheManager = {
        loadRules: () => new Promise(() => undefined),
        getLocalVersion: async () => null,
        getSyncHealthLevel: () => 0,
      };
      controller = new HealthController(makeSopStub({ cache: hangingCache }));

      const start = Date.now();
      const result = await controller.health();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000);
      expect(result.subsystems.database.status).toBe('degraded');
      expect(result.subsystems.database.detail).toContain('timed out');
    }, 5000);

    it('未注入 SOP 服务 → 各组件降级但端点不抛出', async () => {
      controller = new HealthController();

      const result = await controller.health();

      expect(result.status).toBe('degraded');
      expect(result.subsystems.sopRules.detail).toContain('not wired');
    });
  });

  describe('ready()', () => {
    it('全部组件健康 → ready', async () => {
      controller = new HealthController(makeSopStub());

      const result = await controller.ready();

      expect(result.status).toBe('ready');
    });

    it('任一组件降级 → degraded', async () => {
      controller = new HealthController(makeSopStub({ rules: [] }));

      const result = await controller.ready();

      expect(result.status).toBe('degraded');
    });
  });
});
