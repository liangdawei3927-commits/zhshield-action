/**
 * 一键备份系统 — 定时备份调度器
 *
 * 支持 daily / weekly / monthly 三种频率，基于 cron 表达式。
 */
import { type BackupScheduleConfig } from './types';

/** 定时任务回调：可同步或异步完成，调度器按 cron 触发时调用 */
export type CronCallback = () => void | Promise<void>;

const WHITESPACE = /\s+/;

/** 频率 → cron 表达式构建策略表（替代 toCron 中的 switch 分派） */
const CRON_BUILDERS: Partial<
  Record<
    BackupScheduleConfig['frequency'],
    (hour: number, minute: number, schedule: BackupScheduleConfig) => string
  >
> = {
  daily: (hour, minute) => `${minute} ${hour} * * *`,
  weekly: (hour, minute, schedule) => `${minute} ${hour} * * ${schedule.dayOfWeek ?? 0}`,
  monthly: (hour, minute, schedule) => `${minute} ${hour} ${schedule.dayOfMonth ?? 1} * *`,
};

interface ScheduledTask {
  projectId: string;
  cron: string;
  /** 原始调度配置：补跑判定需要 time/frequency/day* 结构信息，cron 字符串不够 */
  schedule: BackupScheduleConfig;
  callback: CronCallback;
  /**
   * 注册方提供的该项目最近一次成功执行时间（epoch ms）。
   * 缺省视为「从未跑过」——此时不做补跑（新装/新项目不应注册瞬间立刻备份）。
   */
  lastRunAt?: number;
  /** 本进程内最近一次触发/补跑的时刻（epoch ms），防同一次欠账被重复补跑 */
  lastFiredAt?: number;
  intervalId?: ReturnType<typeof setInterval>;
}

/** 向回扫描补跑候选的天数上限（monthly 最长需要 62 天覆盖上个月同日） */
const CATCHUP_LOOKBACK_DAYS = 62;

export class BackupScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private started = false;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * 注册定时备份任务
   *
   * @param opts.lastRunAt 该项目最近一次成功备份的 epoch ms（注册方从持久化
   *   备份记录读取）。提供后，若「最近一个应触发时刻」晚于它（即 App 不在线
   *   时错过的那次调度），注册启动时立即补跑一次——这是 2026-10-25 起连续
   *   多日「零点 App 没开 ⇒ 备份从未触发且无人知晓」故障的直接对策。
   *   不传则保持旧行为：只等下一个匹配分钟。
   */
  async registerSchedule(
    projectId: string,
    schedule: BackupScheduleConfig,
    callback: CronCallback,
    opts?: { lastRunAt?: number },
  ): Promise<void> {
    if (!schedule.enabled) return;

    const cronExpression = this.toCron(schedule);
    this.tasks.set(projectId, {
      projectId,
      cron: cronExpression,
      schedule,
      callback,
      lastRunAt: opts?.lastRunAt,
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
    const now = new Date();
    if (this.matchesCron(task.cron, now)) {
      this.fire(task, now.getTime());
      return;
    }
    // 错过补跑：最近一个应触发时刻已过、且晚于上次实际执行 → 立即补一次。
    // lastRunAt 缺省（从未跑过）不补，避免新项目注册瞬间被立即备份。
    const dueAt = this.lastDueAt(task.schedule, now);
    if (dueAt == null) return;
    const lastDone = Math.max(task.lastRunAt ?? 0, task.lastFiredAt ?? 0);
    if (lastDone > 0 && dueAt > lastDone) this.fire(task, dueAt);
  }

  /** 触发回调并记录触发时刻（取应触发时刻而非当前时间，同一欠账只补一次） */
  private fire(task: ScheduledTask, firedAt: number): void {
    task.lastFiredAt = firedAt;
    const result = task.callback();
    if (result instanceof Promise) {
      result.catch(() => {});
    }
  }

  /**
   * 计算「最近一个应触发且已过去的时刻」（epoch ms）；从不匹配返回 null。
   * 从 now 向回逐日构造该日 HH:mm 的候选时刻做 cron 匹配，最多回看 62 天
   * （monthly 需要覆盖上个月同日；daily 第 1 个候选即命中）。
   */
  private lastDueAt(schedule: BackupScheduleConfig, now: Date): number | null {
    const [hour, minute] = schedule.time.split(':').map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    for (let back = 0; back < CATCHUP_LOOKBACK_DAYS; back++) {
      const day = new Date(now);
      day.setDate(day.getDate() - back);
      day.setHours(hour, minute, 0, 0);
      if (day.getTime() <= now.getTime() && this.matchesCron(this.toCron(schedule), day)) {
        return day.getTime();
      }
    }
    return null;
  }

  /**
   * 检查给定时刻是否匹配 cron 表达式
   */
  private matchesCron(cron: string, now: Date = new Date()): boolean {
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
        return value - start >= 0 && (value - start) % parseInt(step, 10) === 0;
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
