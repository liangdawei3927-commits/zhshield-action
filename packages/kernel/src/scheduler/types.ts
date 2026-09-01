export type SchedulerTaskType =
  'pipeline' | 'inspect' | 'security' | 'guard' | 'refactor' | 'deps' | 'techDebt';

export type SchedulerFrequency = 'daily' | 'weekly' | 'monthly';

export interface SchedulerConfig {
  enabled: boolean;
  frequency: SchedulerFrequency;
  time: string;
  tasks: SchedulerTaskType[];
  projectPath: string;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
}

export interface SchedulerJob {
  id: string;
  config: SchedulerConfig;
  nextRun: string;
  lastRun?: string;
  lastStatus?: 'success' | 'failure' | 'skipped';
  createdAt: string;
}

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
