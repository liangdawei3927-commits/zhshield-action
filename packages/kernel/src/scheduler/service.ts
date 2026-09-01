import type { SchedulerConfig, SchedulerJob, SchedulerRunResult, SchedulerStorage } from './types';

function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function calculateNextRun(config: SchedulerConfig): string {
  const now = new Date();
  const [hours, minutes] = config.time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (next <= now) {
    switch (config.frequency) {
      case 'daily':
        next.setDate(next.getDate() + 1);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        break;
      case 'monthly':
        next.setMonth(next.getMonth() + 1);
        break;
    }
  }
  return next.toISOString();
}

export class SchedulerService {
  private jobs: SchedulerJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private onJobRun?: (result: SchedulerRunResult) => void;
  private storage?: SchedulerStorage;

  constructor(options?: {
    storage?: SchedulerStorage;
    onJobRun?: (result: SchedulerRunResult) => void;
  }) {
    this.storage = options?.storage;
    this.onJobRun = options?.onJobRun;
    this.loadJobs();
  }

  private loadJobs(): void {
    if (!this.storage) return;
    this.storage
      .loadJobs()
      .then((loaded) => {
        this.jobs = loaded;
      })
      .catch(() => {
        this.jobs = [];
      });
  }

  private saveJobs(): void {
    if (!this.storage) return;
    this.storage.saveJobs([...this.jobs]).catch(() => {});
  }

  addJob(config: SchedulerConfig): SchedulerJob {
    const job: SchedulerJob = {
      id: generateId(),
      config,
      nextRun: calculateNextRun(config),
      createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    this.saveJobs();
    return job;
  }

  removeJob(jobId: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    this.jobs.splice(idx, 1);
    this.saveJobs();
    return true;
  }

  updateJob(jobId: string, config: Partial<SchedulerConfig>): SchedulerJob | null {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    job.config = { ...job.config, ...config };
    job.nextRun = calculateNextRun(job.config);
    this.saveJobs();
    return job;
  }

  listJobs(): SchedulerJob[] {
    return [...this.jobs];
  }

  getJob(jobId: string): SchedulerJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAndRunDueJobs(), intervalMs);
    this.checkAndRunDueJobs();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private checkAndRunDueJobs(): void {
    const now = new Date();
    for (const job of this.jobs) {
      if (!job.config.enabled) continue;
      if (new Date(job.nextRun) <= now) {
        this.runJob(job);
      }
    }
  }

  private async runJob(job: SchedulerJob): Promise<void> {
    const result: SchedulerRunResult = {
      jobId: job.id,
      startedAt: new Date().toISOString(),
      finishedAt: '',
      status: 'success',
      tasksRun: job.config.tasks,
      results: {},
    };

    try {
      job.lastRun = result.startedAt;
      job.lastStatus = 'success';
      result.finishedAt = new Date().toISOString();
      job.nextRun = calculateNextRun(job.config);
    } catch (err) {
      result.status = 'failure';
      result.error = err instanceof Error ? err.message : String(err);
      job.lastStatus = 'failure';
      result.finishedAt = new Date().toISOString();
    }

    this.saveJobs();
    this.onJobRun?.(result);
  }

  runJobNow(jobId: string): SchedulerRunResult | null {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    const result: SchedulerRunResult = {
      jobId: job.id,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'success',
      tasksRun: job.config.tasks,
      results: {},
    };
    job.lastRun = result.startedAt;
    job.lastStatus = 'success';
    job.nextRun = calculateNextRun(job.config);
    this.saveJobs();
    this.onJobRun?.(result);
    return result;
  }
}
