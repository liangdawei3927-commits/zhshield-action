import type { BrowserWindow } from 'electron';
import { t } from '@zh/i18n';
import { getMainWindow } from './ipc-context';
import {
  runPipelineInWorker,
  runRefactorInWorker,
  runGuardInWorker,
  runSecurityInWorker,
  runGarbageScanInWorker,
  runGarbageCleanInWorker,
  runGarbageRestoreInWorker,
  runPerformanceInWorker,
  cancelJob,
} from './pipeline-host';
import { runDepsHandler } from './ipc/engines-deps';
import { runTechDebtHandler } from './ipc/engines-techdebt';
import { CANCELLED_ERR_TAG } from './pipeline-protocol';

/** 任务类型：各引擎检查域（巡检/安全/垃圾/性能/门禁/重构/依赖/技术债） */
export type TaskKind =
  | 'pipeline'
  | 'security'
  | 'garbage'
  | 'garbageClean'
  | 'garbageRestore'
  | 'performance'
  | 'guard'
  | 'refactor'
  | 'deps'
  | 'techdebt';

/** 任务状态机取值：排队 → 运行 → 完成/失败/取消 */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务信息（广播给渲染进程的任务列表条目）：状态、进度、时间戳与结果/错误 */
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
  /**
   * 触发来源（仅 'auto' 时携带）：每日自动巡检发起的任务。
   * 诊断元数据——UI 忙态文案不区分触发来源（任务在跑按钮就显示同一状态词），
   * 此字段仅供任务中心/日志排查用。手动触发不写此字段（undefined = manual），
   * 广播体积与旧任务零变化。
   */
  origin?: 'auto';
}

type TaskRunner = (
  task: TaskInfo,
  request: unknown,
  onProgress: (stage: string, message: string, pct: number) => void,
) => Promise<unknown>;

/** 同项目同时执行的最大任务数（超过则排队），避免多个全量扫盘打满 CPU/IO */
const MAX_CONCURRENT = 2;
const PROGRESS_BROADCAST_THROTTLE_MS = 150;

/** 看门狗巡检间隔：每 30 秒检查一次有无「无进展」的 running 任务 */
const STALL_WATCHDOG_INTERVAL_MS = 30_000;

/**
 * 任务无进展超时阈值：running 任务超过该时长没有任何 progress 回调
 * （心跳）即判为卡死，自动标 failed 并释放并发槽位，放行后续排队任务。
 * 背景：deps/techdebt 两个 runner 直连主进程执行器、无内建超时，worker 侧
 * 兜底超时长达 30 分钟——卡死任务会占满 MAX_CONCURRENT 槽位，让整个队列
 * 出现「永远排队中」的僵尸（P0-2）。
 */
export const TASK_STALL_TIMEOUT_MS = 5 * 60_000;

interface QueuedJob {
  task: TaskInfo;
  request?: unknown;
}

/**
 * 将请求载荷规范化为稳定的字符串键，用于去重时的「请求身份」比对。
 *
 * - 对象键按字典序排序：{ a, b } 与 { b, a } 得到同一键（键序稳定）；
 * - 数组保持顺序：顺序是载荷语义的一部分，不得视为相等；
 * - 原始值语义与 JSON.stringify 对齐；
 * - undefined / 函数 / Symbol 无 JSON 表示 → 统一固定哨兵 `'null'`
 *   （因此扫描类任务 request 为 undefined 时全部落到同一键，保持既有合并语义）。
 */
export function canonicalRequestKey(request: unknown): string {
  return stableStringify(request);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'string') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString()) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue; // 与 JSON.stringify 一致：跳过 undefined 属性
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // undefined / function / symbol：无 JSON 表示，统一哨兵
  return 'null';
}

/**
 * 纯谓词：在任务列表中寻找可复用（复用而非新建）的任务。
 *
 * 命中条件（全部满足）：状态为 queued|running、kind 相同、projectPath 相同，
 * 且该任务的请求键（由调用方经 requestKeys 映射提供）与 requestKey 相同。
 *
 * 请求键不放进公开的 TaskInfo（避免广播给渲染进程），因此以独立映射传入，
 * 既保持谓词纯函数（无副作用、无外部状态读取），又让请求身份参与比对。
 */
interface FindReusableTaskParams {
  tasks: Iterable<TaskInfo>;
  kind: TaskKind;
  projectPath: string;
  requestKey: string;
  requestKeys: ReadonlyMap<string, string>;
}

export function findReusableTask(params: FindReusableTaskParams): TaskInfo | undefined {
  const { tasks, kind, projectPath, requestKey, requestKeys } = params;
  for (const task of tasks) {
    const active = task.status === 'queued' || task.status === 'running';
    if (
      active &&
      task.kind === kind &&
      task.projectPath === projectPath &&
      requestKeys.get(task.id) === requestKey
    ) {
      return task;
    }
  }
  return undefined;
}

/**
 * 全局任务注册表：统一调度所有引擎检查任务（360 卫士式）。
 * 受限并发 + 排队，状态/进度变化通过 tasks:changed 事件广播给渲染进程。
 */
export class TaskManager {
  private readonly tasks: Map<string, TaskInfo> = new Map();
  private readonly waiters: Map<
    string,
    Set<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>
  > = new Map();
  private readonly queue: QueuedJob[] = [];
  private readonly lastBroadcast: Map<string, number> = new Map();
  // 任务 id → 请求键。刻意不并入 TaskInfo，避免随 tasks:changed 广播给渲染进程。
  private readonly requestKeys: Map<string, string> = new Map();
  private running: number = 0;
  private seq: number = 0;
  /** running 任务 id → 最近一次 progress 心跳时间戳（runTask 启动时初始化） */
  private readonly lastProgressAt: Map<string, number> = new Map();
  /** 被看门狗强制终止的任务 id：其底层 Promise 稍后收尾时据此跳过二次释放槽位 */
  private readonly watchdogKilled: Set<string> = new Set();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runnerByKind: Record<TaskKind, TaskRunner>,
    private readonly getWindow: () => BrowserWindow | null = getMainWindow,
  ) {}

  /**
   * opts.origin 不参与 requestKey（请求身份）：它是"谁按的按钮"不是"查什么"。
   * 因此自动触发与手动触发的同参数任务仍互相复用（去重语义不变），
   * 复用时保留既有任务的 origin 不被覆盖。
   */
  start(
    kind: TaskKind,
    projectPath: string,
    request?: unknown,
    opts?: { origin?: 'auto' },
  ): TaskInfo {
    const requestKey = canonicalRequestKey(request);
    const existing = findReusableTask({
      tasks: this.tasks.values(),
      kind,
      projectPath,
      requestKey,
      requestKeys: this.requestKeys,
    });
    if (existing) return existing;

    const task: TaskInfo = {
      id: `${kind}-${Date.now()}-${++this.seq}`,
      kind,
      projectPath,
      status: 'queued',
      progress: 0,
      startedAt: new Date().toISOString(),
      ...(opts?.origin ? { origin: opts.origin } : {}),
    };
    this.tasks.set(task.id, task);
    this.requestKeys.set(task.id, requestKey);
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
    if (task.status === 'cancelled')
      return Promise.reject(new Error(`${CANCELLED_ERR_TAG} ${t('task.cancelled')}`));
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
      this.requestKeys.delete(task.id);
      this.settle(task);
      this.updateQueuePositions();
      this.broadcast(task);
      return true;
    }
    if (task.status === 'running') {
      try {
        cancelJob(task.id);
      } catch {}
      task.status = 'cancelled';
      task.finishedAt = new Date().toISOString();
      this.requestKeys.delete(task.id);
      this.broadcast(task);
      // 必须立刻唤醒等待方：否则 engine:runXxx 的 IPC 要等执行器自己结束才返回，
      // 页面在「点了停止」之后仍会转圈到任务自然结束（卡住时等于永不返回）。
      this.settle(task);
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
    this.lastProgressAt.set(task.id, Date.now());
    this.ensureWatchdog();
    this.broadcast(task);

    Promise.resolve()
      .then(() =>
        runner(task, request, (stage, message, pct) => {
          if (task.status !== 'running') return;
          this.lastProgressAt.set(task.id, Date.now());
          task.stage = stage;
          task.message = message;
          task.progress = pct;
          this.broadcast(task);
        }),
      )
      .then((result) => {
        // 看门狗可能已把任务标为 failed（槽位已释放），此处不得再改状态
        if (task.status !== 'running') return;
        task.status = 'done';
        task.result = result;
        task.progress = 1;
      })
      .catch((err) => {
        if (task.status !== 'running') return;
        // 取消是用户主动操作，不是故障：执行器把取消当异常抛出时，落 cancelled 而非 failed
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes(CANCELLED_ERR_TAG)) {
          task.status = 'cancelled';
          return;
        }
        task.status = 'failed';
        task.error = message;
      })
      .finally(() => {
        const killedByWatchdog = this.watchdogKilled.delete(task.id);
        this.lastProgressAt.delete(task.id);
        this.stopWatchdogIfIdle();
        if (killedByWatchdog) return; // 槽位/等待方已由看门狗处理，避免二次释放
        task.finishedAt = new Date().toISOString();
        this.requestKeys.delete(task.id);
        this.broadcast(task);
        this.settle(task);
        this.running--;
        this.pump();
      });
  }

  /**
   * 启动看门狗定时器（惰性）：有 running 任务才需要巡检。
   * unref 保证纯 Node 测试环境下定时器不阻塞进程退出。
   */
  private ensureWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkStalledTasks(), STALL_WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdogIfIdle(): void {
    if (this.watchdogTimer && this.running <= 0) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** 看门狗：running 任务超过 TASK_STALL_TIMEOUT_MS 无任何 progress 心跳 → 强制失败并释放槽位 */
  private checkStalledTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      const last = this.lastProgressAt.get(task.id) ?? now;
      if (now - last < TASK_STALL_TIMEOUT_MS) continue;
      this.forceFailStalled(task);
    }
  }

  private forceFailStalled(task: TaskInfo): void {
    this.watchdogKilled.add(task.id);
    this.running--; // 立即释放并发槽位，放行排队任务；底层 Promise 收尾时据此跳过
    try {
      // worker 型 runner 把 task.id 注册为取消键，尽力终止底层作业（直连执行器无此映射，静默即可）
      cancelJob(task.id);
    } catch {}
    task.status = 'failed';
    task.error = t('task.stalledTimeout', { minutes: Math.round(TASK_STALL_TIMEOUT_MS / 60_000) });
    task.finishedAt = new Date().toISOString();
    this.requestKeys.delete(task.id);
    this.broadcast(task);
    this.settle(task);
    this.pump();
  }

  private settle(task: TaskInfo): void {
    const set = this.waiters.get(task.id);
    if (!set) return;
    this.waiters.delete(task.id);
    for (const waiter of set) {
      if (task.status === 'done') {
        waiter.resolve(task.result);
      } else if (task.status === 'cancelled') {
        // 带标记：渲染层据此把"用户取消"从"失败"里摘出来，不弹红页
        waiter.reject(new Error(`${CANCELLED_ERR_TAG} ${t('task.cancelled')}`));
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
  // 每个 runner 都把 task.id 作为最后一个参数传给执行器：取消消息要能被翻译成
  // worker 内部的 job id（见 pipeline-host 的 jobIdByCancelKey），否则 cancel 静默失效。
  const runnerByKind: Record<TaskKind, TaskRunner> = {
    pipeline: (task, request, onProgress) =>
      runPipelineInWorker(
        task.projectPath,
        (request ?? {}) as { dryRun?: boolean; sop?: boolean },
        onProgress,
        undefined,
        task.id,
      ),
    security: (task, _request, onProgress) =>
      runSecurityInWorker(task.projectPath, onProgress, undefined, task.id),
    garbage: (task, _request, onProgress) =>
      runGarbageScanInWorker(task.projectPath, onProgress, undefined, task.id),
    garbageClean: (task, request) =>
      runGarbageCleanInWorker(
        task.projectPath,
        (request as { items: Array<{ id: string; path: string; size: number; type: string }> })
          .items,
        undefined,
        task.id,
      ),
    garbageRestore: (task, request) =>
      runGarbageRestoreInWorker(
        task.projectPath,
        (request as { batchId: string }).batchId,
        undefined,
        task.id,
      ),
    performance: (task, _request, onProgress) =>
      runPerformanceInWorker(task.projectPath, onProgress, undefined, task.id),
    guard: (task, request, onProgress) =>
      runGuardInWorker(
        task.projectPath,
        (request ?? {}) as Record<string, unknown>,
        onProgress,
        undefined,
        task.id,
      ),
    refactor: (task, _request, onProgress) =>
      runRefactorInWorker(task.projectPath, onProgress, undefined, task.id),
    deps: (task, _request, onProgress) => runDepsHandler(task.projectPath, onProgress),
    techdebt: (task, _request, onProgress) => runTechDebtHandler(task.projectPath, onProgress),
  };
  return new TaskManager(runnerByKind);
}
