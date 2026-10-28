/**
 * BackupScheduler（定时备份调度器）回归测试
 *
 * 背景：该调度器在 2026-09-03 之前是死代码——全仓库零调用，应用内"每天定时备份"
 * 功能因此从未生效。接线后（desktop ipc/backup.ts）调度正确性由本文件锁定：
 * 必须能在配置时间触发 trigger='schedule' 的备份回调，且同分钟不重复触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupScheduler } from '../backup/scheduler';
import type { BackupScheduleConfig } from '../backup/types';

function dailyAt(time: string): BackupScheduleConfig {
  return { enabled: true, frequency: 'daily', time };
}

describe('BackupScheduler 定时触发', () => {
  let scheduler: BackupScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new BackupScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('注册即触发匹配当前分钟的 daily 任务（接线后启动场景）', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 10, 0, 0)); // 10:00
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('10:00'), cb);
    scheduler.start();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning()).toBe(true);
    expect(scheduler.listSchedules()).toEqual([{ projectId: 'p1', cron: '0 10 * * *' }]);
  });

  it('非匹配分钟不触发，次日匹配分钟再次触发', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 10, 1, 0)); // 10:01：不匹配
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('10:00'), cb);
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(0);

    // 跳到次日 09:59 后推进一分钟，落在 09-04 10:00 的 tick 上 → 匹配
    vi.setSystemTime(new Date(2026, 8, 4, 9, 59, 0));
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('weekly 按 dayOfWeek 触发，其他星期不触发', async () => {
    // 2026-09-03 是星期四（dayOfWeek=4）
    vi.setSystemTime(new Date(2026, 8, 3, 8, 30, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule(
      'p1',
      { enabled: true, frequency: 'weekly', time: '08:30', dayOfWeek: 4 },
      cb,
    );
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(1);

    // 下一分钟是同一天但 cron 的星期字段仍匹配、分钟不匹配 → 不触发
    vi.setSystemTime(new Date(2026, 8, 3, 8, 31, 0));
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unregisterSchedule 后不再触发', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 22, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('22:00'), cb);
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(1);

    scheduler.unregisterSchedule('p1');
    vi.setSystemTime(new Date(2026, 8, 4, 22, 0, 0));
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(scheduler.listSchedules()).toEqual([]);
  });

  it('enabled=false 的配置不注册任务', async () => {
    const cb = vi.fn();
    await scheduler.registerSchedule(
      'p1',
      { enabled: false, frequency: 'daily', time: '10:00' },
      cb,
    );
    scheduler.start();
    expect(cb).not.toHaveBeenCalled();
    expect(scheduler.listSchedules()).toEqual([]);
  });

  it('stop() 停止调度并清空任务', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 10, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('10:00'), cb);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    expect(scheduler.listSchedules()).toEqual([]);

    // 停止后时间推进到匹配分钟也不再触发
    vi.setSystemTime(new Date(2026, 8, 4, 10, 0, 0));
    vi.advanceTimersByTime(120_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('回调抛错不影响调度器继续运行（下一匹配分钟仍触发）', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 23, 59, 0));
    const cb = vi.fn().mockRejectedValueOnce(new Error('boom'));
    await scheduler.registerSchedule('p1', dailyAt('23:59'), cb);
    scheduler.start();
    // 立即评估触发一次；rejected promise 被调度器 .catch 吞掉，同步调用后无需等待
    expect(cb).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 8, 4, 23, 58, 0));
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('BackupScheduler 错过补跑（2026-10-25 起断备事故对策）', () => {
  let scheduler: BackupScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new BackupScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('lastRunAt 早于今日应触发时刻且 App 错过 → 注册即补跑一次', async () => {
    // 10-03 09:00 开 App；daily 00:00，上次成功备份是 10-01 23:00
    // ⇒ 10-02 与 10-03 的 00:00 都错过了，取最近一次（10-03 00:00）补跑
    vi.setSystemTime(new Date(2026, 8, 3, 9, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('00:00'), cb, {
      lastRunAt: new Date(2026, 8, 1, 23, 0).getTime(),
    });
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('同一欠账只补一次：补跑后推进到非匹配分钟不重复触发', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 9, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('00:00'), cb, {
      lastRunAt: new Date(2026, 8, 1, 23, 0).getTime(),
    });
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(1);

    // 推进 10 分钟：非匹配分钟，且补跑已把 lastFiredAt 记为 dueAt
    vi.advanceTimersByTime(600_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('lastRunAt 晚于最近应触发时刻 → 不补跑', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 9, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('00:00'), cb, {
      lastRunAt: new Date(2026, 8, 3, 8, 0).getTime(), // 今天 08:00 跑过
    });
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(0);
  });

  it('未提供 lastRunAt（从未跑过）→ 不补跑，保持旧行为', async () => {
    vi.setSystemTime(new Date(2026, 8, 3, 9, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule('p1', dailyAt('00:00'), cb);
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(0);
  });

  it('weekly 错过补跑：上周触发日错过、注册日非触发日也立即补', async () => {
    // 2026-09-03 是星期四；weekly dayOfWeek=4 (周四) 08:30
    // 上个触发日 08-27（周四）错过；今天是周四但已过 08:30 ⇒ 今天 08:30 即最近应触发时刻
    vi.setSystemTime(new Date(2026, 8, 3, 12, 0, 0));
    const cb = vi.fn();
    await scheduler.registerSchedule(
      'p1',
      { enabled: true, frequency: 'weekly', time: '08:30', dayOfWeek: 4 },
      cb,
      { lastRunAt: new Date(2026, 7, 20, 8, 30).getTime() }, // 08-20 周四跑过
    );
    scheduler.start();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
