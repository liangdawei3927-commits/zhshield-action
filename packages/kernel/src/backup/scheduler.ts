/**
 * 一键备份系统 — 定时备份调度器
 *
 * 支持 daily / weekly / monthly 三种频率，基于 cron 表达式。
 */
import { type BackupScheduleConfig } from './types';

export type CronCallback = () => void | Promise<void>;

const WHITESPACE = /\s+/;

/** 频率 → cron 表达式构建策略表（替代 toCron 中的 switch 分派） */
const CRON_BUILDERS: Partial<Record<BackupScheduleConfig['frequency'], (hour: number, minute: number, schedule: BackupScheduleConfig) => string>> = {
  daily: (hour, minute) => `${minute} ${hour} * * *`,
  weekly: (hour, minute, schedule) => `${minute} ${hour} * * ${schedule.dayOfWeek ?? 0}`,
  monthly: (hour, minute, schedule) => `${minute} ${hour} ${schedule.dayOfMonth ?? 1} * *`,
};

interface ScheduledTask {
  projectId: string;
  cron: string;
  callback: CronCallback;
  intervalId?: ReturnType<typeof setInterval>;
}

export class BackupScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private started = false;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * 注册定时备份任务
   */
  async registerSchedule(
    projectId: string,
    schedule: BackupScheduleConfig,
    callback: CronCallback,
  ): Promise<void> {
    if (!schedule.enabled) return;

    const cronExpression = this.toCron(schedule);
    this.tasks.set(projectId, {
      projectId,
      cron: cronExpression,
      callback,
    });

    // 如果调度器已启动，立即激活该任务
    if (this.started) {
      this.activateTask(projectId);
    }
  }

  /**
   * 取消定时备份任务
   */
  unregisterSchedule(projectId: string): void {
    const task = this.tasks.get(projectId);
    if (task?.intervalId) {
      clearInterval(task.intervalId);
    }
    this.tasks.delete(projectId);
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // 每分钟检查一次是否需要触发备份
    this.checkIntervalId = setInterval(() => {
      this.checkSchedules();
    }, 60_000);

    // 立即检查一次
    this.checkSchedules();
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.started = false;
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    for (const [id] of this.tasks) {
      this.unregisterSchedule(id);
    }
  }

  /**
   * 列出所有已注册的定时任务
   */
  listSchedules(): Array<{ projectId: string; cron: string }> {
    return Array.from(this.tasks.values(), (t) => ({
      projectId: t.projectId,
      cron: t.cron,
    }));
  }

  /**
   * 判断调度器是否在运行
   */
  isRunning(): boolean {
    return this.started;
  }

  // ─── 私有 ─────────────────────────────────────────────

  private activateTask(projectId: string): void {
    const task = this.tasks.get(projectId);
    if (!task) return;

    // 每分钟检查一次该任务是否需要触发
    const intervalId = setInterval(() => {
      this.evaluateTask(task);
    }, 60_000);

    task.intervalId = intervalId;

    // 启动时立即评估一次
    this.evaluateTask(task);
  }

  private checkSchedules(): void {
    for (const [projectId] of this.tasks) {
      const task = this.tasks.get(projectId);
      if (!task || task.intervalId) continue; // 已激活的由自己的 interval 处理

      this.evaluateTask(task);
    }
  }

  private evaluateTask(task: ScheduledTask): void {
    if (this.matchesCron(task.cron)) {
      const result = task.callback();
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    }
  }

  /**
   * 检查当前时间是否匹配 cron 表达式
   */
  private matchesCron(cron: string): boolean {
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    const dayOfMonth = now.getDate();

    const parts = cron.trim().split(WHITESPACE);
    if (parts.length < 5) return false;

    const [cronMinute, cronHour, cronDayOfMonth, , cronDayOfWeek] = parts;

    return (
      this.cronFieldMatches(cronMinute, minute) &&
      this.cronFieldMatches(cronHour, hour) &&
      this.cronFieldMatches(cronDayOfMonth, dayOfMonth) &&
      this.cronFieldMatches(cronDayOfWeek, dayOfWeek)
    );
  }

  private cronFieldMatches(pattern: string, value: number): boolean {
    if (pattern === '*') return true;

    // 处理逗号分隔的多个值
    return pattern.split(',').some((part) => {
      if (part === String(value)) return true;
      // 处理步长
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const start = range === '*' ? 0 : parseInt(range, 10);
        return (value - start) >= 0 && (value - start) % parseInt(step, 10) === 0;
      }
      // 处理范围
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        return value >= lo && value <= hi;
      }
      return false;
    });
  }

  /**
   * 将调度配置转换为 cron 表达式
   */
  private toCron(schedule: BackupScheduleConfig): string {
    const [hour, minute] = schedule.time.split(':').map(Number);

    const build = CRON_BUILDERS[schedule.frequency];
    return build ? build(hour, minute, schedule) : `${minute} ${hour} * * *`;
  }
}
