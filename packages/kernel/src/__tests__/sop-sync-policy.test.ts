import { describe, it, expect } from 'vitest';
import { createSyncPolicy } from '../sop/cache/sop-sync-policy';

describe('createSyncPolicy', () => {
  it('无参数时使用默认值：6 小时间步间隔 + 7 天过期阈值', () => {
    const policy = createSyncPolicy();
    expect(policy.syncInterval).toBe(6 * 60 * 60 * 1000);
    expect(policy.staleThresholdDays).toBe(7);
  });

  it('空对象配置仍使用默认值', () => {
    const policy = createSyncPolicy({});
    expect(policy.syncInterval).toBe(6 * 60 * 60 * 1000);
    expect(policy.staleThresholdDays).toBe(7);
  });

  it('自定义同步间隔应生效', () => {
    const policy = createSyncPolicy({ syncInterval: 60_000 });
    expect(policy.syncInterval).toBe(60_000);
    // 未提供字段保持默认
    expect(policy.staleThresholdDays).toBe(7);
  });

  it('自定义过期阈值应生效', () => {
    const policy = createSyncPolicy({ staleThresholdDays: 30 });
    expect(policy.staleThresholdDays).toBe(30);
    expect(policy.syncInterval).toBe(6 * 60 * 60 * 1000);
  });

  it('同时自定义两个字段应全部生效', () => {
    const policy = createSyncPolicy({ syncInterval: 1000, staleThresholdDays: 14 });
    expect(policy.syncInterval).toBe(1000);
    expect(policy.staleThresholdDays).toBe(14);
  });

  it('零值显式传入应被采纳（不触发默认值兜底）', () => {
    // syncInterval=0 不切实际，但验证 ?? 仅对 undefined 生效
    const policy = createSyncPolicy({ syncInterval: 0, staleThresholdDays: 0 });
    expect(policy.syncInterval).toBe(0);
    expect(policy.staleThresholdDays).toBe(0);
  });
});
