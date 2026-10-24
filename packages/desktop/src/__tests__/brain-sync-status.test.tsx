import { describe, it, expect } from 'vitest';
import { resolveStatus, describeFailure, formatRelativeDay } from '../components/layout/sidebar-status';
import type { SopSyncHealth } from '../types/electron';

/**
 * 智汇大脑同步状态展示的语义门禁
 *
 * 这里锁的不是「渲染了几行」，而是「同一个 level 在不同历史下必须给出不同结论」。
 * 线上曾经的真实缺陷：从未接入云端（everSucceeded=false）与断了 28 天
 * 都显示「同步已过期」，用户无法判断该去查网络还是查配置。
 *
 * 自证方式：每条绿灯断言都对应一种会被真实数据触发的形态；
 * 若有人把 everSucceeded 从判定中去掉，第 1 组用例立即转红。
 */

/** 直译 t：让断言比对文案键本身，不受 locales 内容变化影响 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

function health(over: Partial<SopSyncHealth>): SopSyncHealth {
  return {
    level: 0,
    everSucceeded: true,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    daysSinceSuccess: null,
    failureKind: 'none',
    ...over,
  };
}

describe('智汇大脑状态判定', () => {
  // ─── ① 从未接入 ≠ 过期（本次修复的核心） ─────────────────
  describe('GIVEN 从未成功同步过', () => {
    it('WHEN level=4 且 everSucceeded=false THEN 显示未接入云端而非已过期', () => {
      const status = resolveStatus(
        health({ level: 4, everSucceeded: false, daysSinceSuccess: null }),
        t,
      );
      expect(status.text).toBe('layout.brainNotConnected');
      // 反证：若判定退化为「只看 level」，这里会变成 brainStale
      expect(status.text).not.toBe('layout.brainStale');
      expect(status.text).not.toBe('layout.brainStaleDays:{"days":0}');
    });

    it('WHEN 从未接入 THEN 圆点为警告色而非危险色（配置问题，非链路故障）', () => {
      const status = resolveStatus(health({ level: 4, everSucceeded: false }), t);
      expect(status.dot).toBe('bg-warning-500');
      expect(status.dot).not.toBe('bg-danger-600');
    });
  });

  // ─── ② 正常 / 待更新 / 过期三态 ──────────────────────────
  describe('GIVEN 曾成功同步过', () => {
    it('WHEN level=0 THEN 显示运行正常（绿点）', () => {
      const status = resolveStatus(health({ level: 0 }), t);
      expect(status.text).toBe('layout.brainHealthy');
      expect(status.dot).toBe('bg-success-700');
    });

    it('WHEN level=2 THEN 显示规则待更新（警告色）', () => {
      const status = resolveStatus(health({ level: 2 }), t);
      expect(status.text).toBe('layout.brainUpdating');
      expect(status.dot).toBe('bg-warning-500');
    });

    it('WHEN level=4 且断 28 天 THEN 显示具体天数（危险色）', () => {
      const status = resolveStatus(
        health({ level: 4, everSucceeded: true, daysSinceSuccess: 28.4 }),
        t,
      );
      expect(status.text).toBe('layout.brainStaleDays:{"days":28}');
      expect(status.dot).toBe('bg-danger-600');
    });
  });

  // ─── ③ 空态 ────────────────────────────────────────────
  it('GIVEN 健康度尚未取到 WHEN 渲染 THEN 显示正在检查', () => {
    expect(resolveStatus(null, t).text).toBe('layout.brainChecking');
  });
});

describe('失败原因分类文案', () => {
  it('WHEN network THEN 给出云端不可达', () => {
    expect(describeFailure('network', t)).toBe('layout.brainErrorNetwork');
  });

  it('WHEN 最近一次成功（none）THEN 不显示任何原因行', () => {
    expect(describeFailure('none', t)).toBeNull();
  });

  it('WHEN 未识别的失败 THEN 透出通用同步失败而非编造解释', () => {
    expect(describeFailure('unknown', t)).toBe('layout.brainErrorUnknown');
  });
});

describe('相对天数格式化', () => {
  const isoDaysAgo = (days: number): string =>
    new Date(Date.now() - days * 86_400_000).toISOString();

  it('WHEN 时间戳为今天 THEN 显示今天', () => {
    expect(formatRelativeDay(new Date().toISOString(), t)).toBe('layout.brainToday');
  });

  it('WHEN 时间戳为 1 天前 THEN 显示昨天', () => {
    expect(formatRelativeDay(isoDaysAgo(1), t)).toBe('layout.brainYesterday');
  });

  it('WHEN 时间戳为 28 天前 THEN 显示 28 天前', () => {
    expect(formatRelativeDay(isoDaysAgo(28), t)).toBe('layout.brainDaysAgo:{"days":28}');
  });

  it('WHEN 时间戳缺失或非法 THEN 返回 null（不显示半截文案）', () => {
    expect(formatRelativeDay(null, t)).toBeNull();
    expect(formatRelativeDay('not-a-date', t)).toBeNull();
  });
});
