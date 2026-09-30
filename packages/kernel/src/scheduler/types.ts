/** 调度任务类型：一次调度运行中可按序执行的任务种类 */
export type SchedulerTaskType =
  'pipeline' | 'inspect' | 'security' | 'guard' | 'refactor' | 'deps' | 'techDebt';

/** 调度频率：daily / weekly / monthly */
export type SchedulerFrequency = 'daily' | 'weekly' | 'monthly';

/**
 * 调度任务配置。
 * time 为 HH:mm 触发时刻，tasks 列出本次调度要执行的任务。
 */
export interface SchedulerConfig {
  enabled: boolean;
  frequency: SchedulerFrequency;
  time: string;
  tasks: SchedulerTaskType[];
  projectPath: string;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
}

/** 调度作业：配置 + 下次/上次运行时间与上次执行状态 */
export interface SchedulerJob {
  id: string;
  config: SchedulerConfig;
  nextRun: string;
  lastRun?: string;
  lastStatus?: 'success' | 'failure' | 'skipped';
  createdAt: string;
}

/** 单次调度运行结果：起止时间、总体状态、实际执行的任务与各任务返回 */
export interface SchedulerRunResult {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'failure' | 'skipped';
  tasksRun: SchedulerTaskType[];
  results: Record<string, unknown>;
  error?: string;
}

/**
 * Storage adapter for SchedulerService persistence.
 *
 * The kernel is storage-agnostic — the host (Electron, server, browser)
 * provides concrete load / save implementations so the same SchedulerService
 * works across environments without depending on localStorage or fs directly.
 */
export interface SchedulerStorage {
  /** Return the persisted jobs array, or [] if nothing stored yet / file missing. */
  loadJobs(): Promise<SchedulerJob[]>;
  /** Persist the full jobs array. Must be idempotent. */
  saveJobs(jobs: SchedulerJob[]): Promise<void>;
}
