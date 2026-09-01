import type { BrowserWindow } from 'electron';
import { t } from '@zh/i18n';
import { getMainWindow } from './ipc-context';
import {
  runPipelineInWorker,
  runRefactorInWorker,
  runGuardInWorker,
  runInspectInWorker,
  runSecurityInWorker,
  runGarbageCleanInWorker,
  runGarbageRestoreInWorker,
  runPerformanceInWorker,
} from './pipeline-host';

export type TaskKind =
  | 'pipeline'
  | 'inspect'
  | 'security'
  | 'garbageClean'
  | 'garbageRestore'
  | 'performance'
  | 'guard'
  | 'refactor';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskInfo {
  id: string;
  kind: TaskKind;
  projectPath: string;
  status: TaskStatus;
  stage?: string;
  message?: string;
  progress: number;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  queuePosition?: number;
}

type TaskRunner = (
  task: TaskInfo,
  request: unknown,
  onProgress: (stage: string, message: string, pct: number) => void,
) => Promise<unknown>;

/** 同项目同时执行的最大任务数（超过则排队），避免多个全量扫盘打满 CPU/IO */
const MAX_CONCURRENT = 2;
const PROGRESS_BROADCAST_THROTTLE_MS = 150;

interface QueuedJob {
  task: TaskInfo;
  request?: unknown;
}

/**
 * 全局任务注册表：统一调度所有引擎检查任务（360 卫士式）。
 * 受限并发 + 排队，状态/进度变化通过 tasks:changed 事件广播给渲染进程。
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly waiters = new Map<
    string,
    Set<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>
  >();
  private readonly queue: QueuedJob[] = [];
  private readonly lastBroadcast = new Map<string, number>();
  private running = 0;
  private seq = 0;

  constructor(
    private readonly runnerByKind: Record<TaskKind, TaskRunner>,
    private readonly getWindow: () => BrowserWindow | null = getMainWindow,
  ) {}

  start(kind: TaskKind, projectPath: string, request?: unknown): TaskInfo {
    const existing = [...this.tasks.values()].find(
      (t) =>
        t.kind === kind &&
        t.projectPath === projectPath &&
        (t.status === 'queued' || t.status === 'running'),
    );
    if (existing) return existing;

    const task: TaskInfo = {
      id: `${kind}-${Date.now()}-${++this.seq}`,
      kind,
      projectPath,
      status: 'queued',
      progress: 0,
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    this.queue.push({ task, request });
    this.updateQueuePositions();
    this.pump();
    return task;
  }

  get(id: string): TaskInfo | undefined {
    return this.tasks.get(id);
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()];
  }

  /** 等待任务完成/失败（供 engine:runXxx 等同步 IPC 复用） */
  waitFor(id: string): Promise<unknown> {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(t('task.notFound')));
    if (task.status === 'done') return Promise.resolve(task.result);
    if (task.status === 'failed')
      return Promise.reject(new Error(task.error ?? t('task.executionFailed')));
    if (task.status === 'cancelled') return Promise.reject(new Error(t('task.cancelled')));
    return new Promise((resolve, reject) => {
      const set = this.waiters.get(id) ?? new Set();
      set.add({ resolve, reject });
      this.waiters.set(id, set);
    });
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'queued') {
      const idx = this.queue.findIndex((q) => q.task.id === id);
      if (idx >= 0) this.queue.splice(idx, 1);
      task.status = 'cancelled';
      task.finishedAt = new Date().toISOString();
      this.settle(task);
      this.updateQueuePositions();
      this.broadcast(task);
      return true;
    }
    if (task.status === 'running') {
      task.status = 'cancelled';
      task.finishedAt = new Date().toISOString();
      this.broadcast(task);
      return true;
    }
    return false;
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.runTask(job);
    }
  }

  private runTask(job: QueuedJob): void {
    const { task, request } = job;
    const runner = this.runnerByKind[task.kind];
    this.running++;
    task.status = 'running';
    task.queuePosition = undefined;
    this.broadcast(task);

    Promise.resolve()
      .then(() =>
        runner(task, request, (stage, message, pct) => {
          if (task.status === 'cancelled') return;
          task.stage = stage;
          task.message = message;
          task.progress = pct;
          this.broadcast(task);
        }),
      )
      .then((result) => {
        if (task.status === 'cancelled') return;
        task.status = 'done';
        task.result = result;
        task.progress = 1;
      })
      .catch((err) => {
        if (task.status === 'cancelled') return;
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        task.finishedAt = new Date().toISOString();
        this.broadcast(task);
        this.settle(task);
        this.running--;
        this.pump();
      });
  }

  private settle(task: TaskInfo): void {
    const set = this.waiters.get(task.id);
    if (!set) return;
    this.waiters.delete(task.id);
    for (const waiter of set) {
      if (task.status === 'done') {
        waiter.resolve(task.result);
      } else {
        waiter.reject(new Error(task.error ?? t('task.notCompleted')));
      }
    }
  }

  private updateQueuePositions(): void {
    this.queue.forEach((job, i) => {
      job.task.queuePosition = i + 1;
      this.broadcast(job.task);
    });
  }

  private broadcast(task: TaskInfo): void {
    const now = Date.now();
    const last = this.lastBroadcast.get(task.id) ?? 0;
    if (task.status === 'running' && now - last < PROGRESS_BROADCAST_THROTTLE_MS) return;
    this.lastBroadcast.set(task.id, now);
    this.getWindow()?.webContents.send('tasks:changed', task);
  }
}

export function buildTaskManager(): TaskManager {
  const runnerByKind: Record<TaskKind, TaskRunner> = {
    pipeline: (task, request, onProgress) =>
      runPipelineInWorker(
        task.projectPath,
        (request ?? {}) as { dryRun?: boolean; sop?: boolean },
        onProgress,
      ),
    inspect: (task, _request, onProgress) => runInspectInWorker(task.projectPath, onProgress),
    security: (task, _request, onProgress) => runSecurityInWorker(task.projectPath, onProgress),
    garbageClean: (task, request) =>
      runGarbageCleanInWorker(
        task.projectPath,
        (request as { items: Array<{ id: string; path: string; size: number; type: string }> })
          .items,
      ),
    garbageRestore: (task, request) =>
      runGarbageRestoreInWorker(task.projectPath, (request as { batchId: string }).batchId),
    performance: (task, _request, onProgress) =>
      runPerformanceInWorker(task.projectPath, onProgress),
    guard: (task, request, onProgress) =>
      runGuardInWorker(task.projectPath, (request ?? {}) as Record<string, unknown>, onProgress),
    refactor: (task, _request, onProgress) => runRefactorInWorker(task.projectPath, onProgress),
  };
  return new TaskManager(runnerByKind);
}
