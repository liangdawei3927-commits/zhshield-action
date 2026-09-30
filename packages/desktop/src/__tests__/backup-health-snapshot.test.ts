import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/zh-backup-health-test') },
}));

import {
  buildBackupHealthSnapshot,
  type BackupRecordLike,
} from '../../electron/ipc/backup';

/**
 * 备份健康快照聚合（十域评分章程 #10）
 *
 * 2026-09-22 回归：此前 loadBackupHealthSnapshot 在读取持久化记录时误用
 * `overallStatus` 字段名（kernel BackupRecord 实际字段为 `status`），
 * 导致全部成功备份被判为 failed → 备份维被扣到 30 分。
 * 本测试锁定「status 为唯一状态字段」的读取契约。
 */
function rec(over: Partial<BackupRecordLike>): BackupRecordLike {
  return {
    projectId: '/proj',
    timestamp: '2026-09-21T10:00:00.000Z',
    status: 'success',
    ...over,
  };
}

describe('buildBackupHealthSnapshot 备份健康快照聚合', () => {
  it('有 success 记录且启用定时备份 → lastSuccessAt 非空、recentStatuses 记录真实 status（2026-09-22 修复）', () => {
    const snap = buildBackupHealthSnapshot([rec({})], true);
    expect(snap).not.toBeNull();
    expect(snap?.lastSuccessAt).toBe('2026-09-21T10:00:00.000Z');
    expect(snap?.recentStatuses).toEqual(['success']);
    expect(snap?.scheduleEnabled).toBe(true);
  });

  it('mixed 记录按新→旧排序，最近 10 条全部按原始 status 透传', () => {
    const snap = buildBackupHealthSnapshot(
      [
        rec({ timestamp: '2026-09-01T00:00:00.000Z', status: 'failed' }),
        rec({ timestamp: '2026-09-03T00:00:00.000Z', status: 'partial' }),
        rec({ timestamp: '2026-09-02T00:00:00.000Z', status: 'success' }),
      ],
      false,
    );
    expect(snap?.recentStatuses).toEqual(['partial', 'success', 'failed']);
    expect(snap?.lastSuccessAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('全部 failed/partial 且无成功 → lastSuccessAt 为 null', () => {
    const snap = buildBackupHealthSnapshot(
      [rec({ status: 'failed' }), rec({ status: 'partial' })],
      true,
    );
    expect(snap?.lastSuccessAt).toBeNull();
    expect(snap?.recentStatuses).toEqual(['failed', 'partial']);
  });

  it('无记录且未启用定时备份 → null（功能未使用 → not-run 不罚分）', () => {
    expect(buildBackupHealthSnapshot([], false)).toBeNull();
  });
});