import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SopSyncScheduler } from '../sop/cache/sop-sync-scheduler';
import { createSyncPolicy } from '../sop/cache/sop-sync-policy';
import type { SyncPolicyOptions } from '../sop/cache/sop-sync-policy';

describe('SopSyncScheduler', () => {
  let policy: Required<SyncPolicyOptions>;
  let scheduler: SopSyncScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    // 设置一个固定的“现在”，便于基于天数偏移测试
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    policy = createSyncPolicy({ syncInterval: 1000, staleThresholdDays: 7 });
    scheduler = new SopSyncScheduler(policy);
  });

  afterEach(() => {
    scheduler.stopPeriodicSync();
    vi.useRealTimers();
  });

  // ─── 在线状态 ─────────────────────────────────────
  describe('在线状态', () => {
    it('默认应在线', () => {
      expect(scheduler.isOnline).toBe(true);
    });

    it('setOnline(false) 后应离线', () => {
      scheduler.setOnline(false);
      expect(scheduler.isOnline).toBe(false);
    });

    it('setOnline 可来回切换', () => {
      scheduler.setOnline(false);
      expect(scheduler.isOnline).toBe(false);
      scheduler.setOnline(true);
      expect(scheduler.isOnline).toBe(true);
    });
  });

  // ─── 定时同步调度 ─────────────────────────────────
  describe('startPeriodicSync / stopPeriodicSync', () => {
    it('start 后应按 syncInterval 周期性调用 onSync', () => {
      const onSync = vi.fn().mockResolvedValue({ updated: false });
      scheduler.startPeriodicSync(onSync);
      expect(onSync).not.toHaveBeenCalled();

      // 推进一个 interval
      vi.advanceTimersByTime(1000);
      expect(onSync).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(onSync).toHaveBeenCalledTimes(2);
    });

    it('重复 start 不应重建定时器（避免多个定时器叠加）', () => {
      const onSync = vi.fn().mockResolvedValue({ updated: false });
      scheduler.startPeriodicSync(onSync);
      scheduler.startPeriodicSync(onSync); // 重复调用应被忽略

      vi.advanceTimersByTime(1000);
      // 只应触发一次（单个定时器）
      expect(onSync).toHaveBeenCalledTimes(1);
    });

    it('stop 后应停止触发 onSync', () => {
      const onSync = vi.fn().mockResolvedValue({ updated: false });
      scheduler.startPeriodicSync(onSync);
      scheduler.stopPeriodicSync();

      vi.advanceTimersByTime(5000);
      expect(onSync).not.toHaveBeenCalled();
    });

    it('未 start 时调用 stop 不应报错', () => {
      expect(() => scheduler.stopPeriodicSync()).not.toThrow();
    });

    it('onSync 抛错不应崩溃定时器（void 吞掉 rejection）', () => {
      const onSync = vi.fn().mockRejectedValue(new Error('sync failed'));
      scheduler.startPeriodicSync(onSync);
      // 推进时间不应抛出未捕获异常
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(onSync).toHaveBeenCalledTimes(1);
    });
  });

  // ─── recordSync ──────────────────────────────────
  describe('recordSync', () => {
    it('recordSync 应记录最近同步时间', () => {
      scheduler.recordSync();
      // 记录后健康度应脱离 Level 4
      expect(scheduler.getSyncHealthLevel()).toBe(0);
    });
  });

  // ─── getSyncHealthLevel ──────────────────────────
  describe('getSyncHealthLevel', () => {
    it('未水合且本进程从未同步应返回 Level 4（兜底）', () => {
      expect(scheduler.getSyncHealthLevel()).toBe(4);
    });

    it('1 天内同步应返回 Level 0（正常）', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(12 * 60 * 60 * 1000); // 12 小时
      expect(scheduler.getSyncHealthLevel()).toBe(0);
    });

    it('1-3 天应返回 Level 1', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(2 * 86_400_000); // 2 天
      expect(scheduler.getSyncHealthLevel()).toBe(1);
    });

    it('3-7 天应返回 Level 2', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(5 * 86_400_000); // 5 天
      expect(scheduler.getSyncHealthLevel()).toBe(2);
    });

    it('7-14 天应返回 Level 3', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(10 * 86_400_000); // 10 天
      expect(scheduler.getSyncHealthLevel()).toBe(3);
    });

    it('超过 14 天应返回 Level 4', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(15 * 86_400_000); // 15 天
      expect(scheduler.getSyncHealthLevel()).toBe(4);
    });

    it('边界：刚好 1 天应返回 Level 0', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(86_400_000); // 恰好 1 天
      expect(scheduler.getSyncHealthLevel()).toBe(0);
    });

    it('边界：刚好 3 天应返回 Level 1', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(3 * 86_400_000);
      expect(scheduler.getSyncHealthLevel()).toBe(1);
    });
  });

  // ─── isStale ─────────────────────────────────────
  describe('isStale', () => {
    it('从未同步应返回 true（过期）', () => {
      expect(scheduler.isStale()).toBe(true);
    });

    it('同步后立即应返回 false（未过期）', () => {
      scheduler.recordSync();
      expect(scheduler.isStale()).toBe(false);
    });

    it('超过 staleThresholdDays（7天）应返回 true', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(8 * 86_400_000); // 8 天
      expect(scheduler.isStale()).toBe(true);
    });

    it('刚好 7 天应返回 false（<= 阈值未过期）', () => {
      scheduler.recordSync();
      vi.advanceTimersByTime(7 * 86_400_000);
      expect(scheduler.isStale()).toBe(false);
    });

    it('自定义 staleThresholdDays 应生效', () => {
      const customPolicy = createSyncPolicy({ syncInterval: 1000, staleThresholdDays: 2 });
      const customScheduler = new SopSyncScheduler(customPolicy);
      customScheduler.recordSync();
      vi.advanceTimersByTime(3 * 86_400_000); // 3 天 > 2 天阈值
      expect(customScheduler.isStale()).toBe(true);
    });
  });

  // ─── hydrate：健康度必须基于磁盘事实 ─────────────
  // 回归背景：健康度原先只看内存 lastSyncTime，进程重启即归零，
  // 于是「本次运行还没同步成功」被误判成「规则严重过期」——
  // 桌面端每次重启都会把一天的正常离线显示成红点。
  describe('hydrate（从持久化状态恢复）', () => {
    it('水合 12 小时前成功 → Level 0，而非重启后的 Level 4', () => {
      scheduler.hydrate({
        lastSuccessAt: '2026-07-31T12:00:00.000Z',
        lastAttemptAt: '2026-07-31T12:00:00.000Z',
        lastError: null,
        everSucceeded: true,
      });

      expect(scheduler.getSyncHealthLevel()).toBe(0);
      expect(scheduler.isStale()).toBe(false);
    });

    it('水合 30 天前成功 → Level 4，且能给出「距上次成功多少天」', () => {
      scheduler.hydrate({
        lastSuccessAt: '2026-07-02T00:00:00.000Z',
        lastAttemptAt: null,
        lastError: 'network_error',
        everSucceeded: true,
      });

      const detail = scheduler.getSyncHealthDetail();
      expect(detail.level).toBe(4);
      expect(detail.everSucceeded).toBe(true);
      expect(detail.daysSinceSuccess).toBeCloseTo(30, 0);
    });

    it('水合空状态 → Level 4 且 everSucceeded=false（区分「从未接入」与「已过期」）', () => {
      scheduler.hydrate({
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        everSucceeded: false,
      });

      const detail = scheduler.getSyncHealthDetail();
      expect(detail.level).toBe(4);
      expect(detail.everSucceeded).toBe(false);
      expect(detail.daysSinceSuccess).toBeNull();
    });

    it('lastSuccessAt 存在但 everSucceeded=false → 以时间戳为准', () => {
      scheduler.hydrate({
        lastSuccessAt: '2026-07-31T12:00:00.000Z',
        lastAttemptAt: null,
        lastError: null,
        everSucceeded: false,
      });

      expect(scheduler.getSyncHealthDetail().everSucceeded).toBe(true);
    });

    it('非法时间字符串不得污染健康度', () => {
      scheduler.hydrate({
        lastSuccessAt: 'not-a-date',
        lastAttemptAt: 'also-bad',
        lastError: null,
        everSucceeded: true,
      });

      expect(scheduler.getSyncHealthLevel()).toBe(4);
      expect(scheduler.getSyncHealthDetail().lastSuccessAt).toBeNull();
    });
  });

  // ─── 失败记录：失败不得刷新「上次成功」 ───────────
  describe('recordSyncFailure', () => {
    it('失败不刷新 lastSuccessAt，过期判断不被失败掩盖', () => {
      scheduler.hydrate({
        lastSuccessAt: '2026-07-02T00:00:00.000Z',
        lastAttemptAt: null,
        lastError: null,
        everSucceeded: true,
      });
      scheduler.recordSyncFailure('network_error');

      const detail = scheduler.getSyncHealthDetail();
      expect(detail.level).toBe(4);
      expect(detail.lastSuccessAt).toBe('2026-07-02T00:00:00.000Z');
      expect(detail.lastAttemptAt).toBe('2026-08-01T00:00:00.000Z');
      expect(detail.failureKind).toBe('network');
    });

    it('失败原因归类：网络/兼容/验签/未知各归其位', () => {
      const cases: Array<[string, string]> = [
        ['network_error', 'network'],
        ['compatibility_error', 'compatibility'],
        ['Hash mismatch: expected=a, got=b', 'signature'],
        ['something weird', 'unknown'],
      ];

      for (const [reason, expected] of cases) {
        scheduler.recordSyncFailure(reason);
        expect(scheduler.getSyncHealthDetail().failureKind).toBe(expected);
      }
    });

    it('成功后 lastError 复位为 null', () => {
      scheduler.recordSyncFailure('network_error');
      expect(scheduler.getSyncHealthDetail().lastError).toBe('network_error');

      scheduler.recordSync();
      expect(scheduler.getSyncHealthDetail().lastError).toBeNull();
      expect(scheduler.getSyncHealthDetail().failureKind).toBe('none');
    });
  });

  // ─── getState / hydrate 往返 ────────────────────
  describe('getState 持久化往返', () => {
    it('getState → hydrate 到新实例，状态完全一致', () => {
      scheduler.recordSyncFailure('network_error');
      const restored = new SopSyncScheduler(policy);
      restored.hydrate(scheduler.getState());

      expect(restored.getState()).toEqual(scheduler.getState());
      expect(restored.getSyncHealthLevel()).toBe(scheduler.getSyncHealthLevel());
    });

    it('从未成功过时 everSucceeded 保持 false（不得因 recordSyncFailure 变 true）', () => {
      scheduler.recordSyncFailure('network_error');
      expect(scheduler.getState().everSucceeded).toBe(false);
      expect(scheduler.getState().lastSuccessAt).toBeNull();
    });
  });
});
