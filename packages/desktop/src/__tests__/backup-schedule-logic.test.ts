/**
 * 备份定时调度接线回归测试（desktop ipc/backup.ts 的可测核心）
 *
 * 背景（2026-09-03 故障）：
 *  1. kernel BackupScheduler 从未被 desktop 接线 → "每天定时备份"设置保存后无人执行；
 *  2. BackupOrchestrator 构造未传 eventBus → 备份进度事件到不了渲染层，大包期间 UI 零反馈。
 * 本文件锁定接线层的纯逻辑：同分钟去重、配置→任务注册同步。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  // ipc-context.ts 模块加载时调用 app.getPath('userData')，mock 缺 app 会导致套件加载失败
  app: { getPath: vi.fn(() => '/tmp/zh-backup-ipc-test') },
}));

import { createScheduleRunner, minuteKey, syncProjectSchedule } from '../../electron/ipc/backup';
import type { BackupScheduleConfig } from '@zh/kernel';

describe('minuteKey 同分钟归桶', () => {
  it('同一分钟内的两个时刻归同一桶，跨分钟归不同桶', () => {
    const t0 = Date.UTC(2026, 8, 3, 2, 0, 0);
    expect(minuteKey(t0)).toBe(minuteKey(t0 + 59_999));
    expect(minuteKey(t0)).not.toBe(minuteKey(t0 + 60_000));
  });
});

describe('createScheduleRunner 同分钟去重', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3, 10, 0, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一分钟内重复调用只执行一次（调度器双 tick 不再重复备份）', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { run } = createScheduleRunner(execute);

    await run('p1');
    await run('p1');
    await run('p1');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('p1');
  });

  it('跨分钟后再次调用会执行', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { run } = createScheduleRunner(execute);

    await run('p1');
    vi.setSystemTime(new Date(2026, 8, 3, 10, 1, 30));
    await run('p1');

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('不同项目互不影响去重', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { run } = createScheduleRunner(execute);

    await run('p1');
    await run('p2');

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('execute 抛错不向外传播（调度器回调不能崩）', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('disk full'));
    const { run } = createScheduleRunner(execute);

    await expect(run('p1')).resolves.toBeUndefined();
  });
});

describe('syncProjectSchedule 配置→任务同步', () => {
  const makeDeps = (schedule: BackupScheduleConfig) => ({
    scheduler: {
      registerSchedule: vi.fn().mockResolvedValue(undefined),
      unregisterSchedule: vi.fn(),
    },
    loadScheduleConfig: vi.fn().mockResolvedValue(schedule),
    runBackup: vi.fn().mockResolvedValue(undefined),
  });

  it('enabled=true 注册任务并把 runBackup 绑定为回调', async () => {
    const deps = makeDeps({ enabled: true, frequency: 'daily', time: '03:30' });
    await syncProjectSchedule(deps, '/proj/a');

    expect(deps.scheduler.registerSchedule).toHaveBeenCalledTimes(1);
    expect(deps.scheduler.registerSchedule).toHaveBeenCalledWith(
      '/proj/a',
      { enabled: true, frequency: 'daily', time: '03:30' },
      expect.any(Function),
    );
    expect(deps.scheduler.unregisterSchedule).not.toHaveBeenCalled();

    // 回调执行走 runBackup（同分钟去重由 createScheduleRunner 负责）
    const callback = deps.scheduler.registerSchedule.mock.calls[0][2] as () => Promise<void>;
    await callback();
    expect(deps.runBackup).toHaveBeenCalledWith('/proj/a');
  });

  it('enabled=false 注销已有任务', async () => {
    const deps = makeDeps({ enabled: false, frequency: 'daily', time: '03:30' });
    await syncProjectSchedule(deps, '/proj/a');

    expect(deps.scheduler.registerSchedule).not.toHaveBeenCalled();
    expect(deps.scheduler.unregisterSchedule).toHaveBeenCalledWith('/proj/a');
  });

  it('配置读取失败不崩溃（损坏的 backup.yml 不应拖垮主进程）', async () => {
    const deps = makeDeps({ enabled: true, frequency: 'daily', time: '03:30' });
    deps.loadScheduleConfig.mockRejectedValue(new Error('yaml parse error'));

    await expect(syncProjectSchedule(deps, '/proj/bad')).resolves.toBeUndefined();
    expect(deps.scheduler.registerSchedule).not.toHaveBeenCalled();
  });
});
