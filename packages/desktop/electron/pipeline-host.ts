/**
 * Pipeline / Refactor 子进程宿主
 *
 * 在 Electron 主进程中 fork 独立 Node 子进程执行体检与重构，
 * 主进程只做消息转发，保持 UI 线程可响应（避免 macOS 彩球）。
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { t, getLanguage } from '@zh/i18n';
import type { PipelineReport } from '@zh/pipeline';
import type { RefactorReport } from '@zh/refactor';
import type { PipelineProgressMsg, PipelineResultMsg, PipelineErrorMsg, PipelineWorkerOutbound } from './pipeline-protocol';
import { readConfig } from './ipc/guard-config';

export type ProgressHandler = (stage: string, message: string, progress: number) => void;

const WORKER_SCRIPT = path.join(__dirname, 'pipeline-worker.js');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_LIMIT = 4000;

interface PendingJob {
  resolve: (report: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressHandler;
  timer: ReturnType<typeof setTimeout>;
  lastStage?: string;
  lastMessage?: string;
}

interface SendJobOptions {
  timeoutMs: number;
  timeoutLabel: string;
  onProgress?: ProgressHandler;
}

let worker: ChildProcess | null = null;
let ready = false;
let readyWaiters: Array<() => void> = [];
let seq = 0;
const pending = new Map<string, PendingJob>();
let stderrTail = '';

function rejectAll(err: Error): void {
  for (const [, job] of pending) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  pending.clear();
}

function buildExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  const jobs = [...pending.values()];
  const last = jobs.at(-1);
  const stageHint = last?.lastStage
    ? `${t('pipeline.exitError.stageHintPrefix')}${last.lastStage}${last.lastMessage ? ` (${last.lastMessage})` : ''}`
    : '';
  const logHint = stderrTail.trim()
    ? `${t('pipeline.exitError.logHintPrefix')}${stderrTail.trim().slice(-500)}`
    : '';
  return new Error(
    `[pipeline-host] ${t('pipeline.exitError.message', { code: code ?? 'null', signal: signal ?? 'null' })}${stageHint}${logHint}`,
  );
}

function notifyReady(): void {
  ready = true;
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) w();
}

function waitUntilReady(timeoutMs = 30_000): Promise<void> {
  if (ready && worker && !worker.killed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[pipeline-host] ${t('pipeline.workerTimeout')}`));
    }, timeoutMs);
    readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 更新待办任务的进度信息 */
function applyProgress(job: PendingJob, msg: PipelineProgressMsg): void {
  job.lastStage = msg.stage;
  job.lastMessage = msg.message;
  job.onProgress?.(msg.stage, msg.message, msg.progress);
}

/** 终结待办任务：清理定时器并 resolve/reject */
function settleJob(job: PendingJob, msg: PipelineResultMsg | PipelineErrorMsg): void {
  clearTimeout(job.timer);
  pending.delete(msg.id);

  if (msg.type === 'result') {
    job.resolve(msg.report);
    return;
  }

  if (msg.type === 'error') {
    job.reject(new Error(msg.error));
  }
}

/** 就绪消息处理：唤醒等待子进程就绪的调用方 */
function handleReadyMessage(): void {
  notifyReady();
}

/** 进度消息处理：更新待办任务的进度信息 */
function handleProgressMessage(job: PendingJob, msg: PipelineProgressMsg): void {
  applyProgress(job, msg);
}

/** worker 消息分发：就绪 / 进度 / 结果与错误 */
function handleWorkerMessage(msg: PipelineWorkerOutbound): void {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ready') {
    handleReadyMessage();
    return;
  }

  const job = pending.get(msg.id);
  if (!job) return;

  dispatchWorkerMessage(job, msg);
}

function dispatchWorkerMessage(job: PendingJob, msg: PipelineProgressMsg | PipelineResultMsg | PipelineErrorMsg): void {
  if (msg.type === 'progress') {
    handleProgressMessage(job, msg);
    return;
  }

  settleJob(job, msg);
}

function attachWorker(child: ChildProcess): void {
  child.on('message', (msg) => {
    handleWorkerMessage(msg as PipelineWorkerOutbound);
  });

  child.on('error', (err) => {
    console.error('[pipeline-host] 子进程错误:', err);
    ready = false;
    worker = null;
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });

  child.on('exit', (code, signal) => {
    console.warn(`[pipeline-host] 子进程退出 code=${code} signal=${signal}`);
    ready = false;
    worker = null;
    if (pending.size > 0) {
      rejectAll(buildExitError(code, signal));
    }
  });

  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString();
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    console.error('[pipeline-worker]', text.trimEnd());
  });
}

/** 确保子进程存活（崩溃后自动拉起） */
export function ensurePipelineWorker(): ChildProcess {
  if (worker && !worker.killed) return worker;

  ready = false;
  stderrTail = '';
  const child = fork(WORKER_SCRIPT, [], {
    env: {
      ...process.env,
      LNG: getLanguage(),
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=4096'].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  worker = child;
  attachWorker(child);
  return child;
}

export function preheatPipelineWorker(): void {
  try {
    ensurePipelineWorker();
  } catch (err) {
    console.warn('[pipeline-host] 预热失败（将在首次任务时重试）:', err);
  }
}

/** 任务超时处理：终结待办任务并终止子进程 */
function handleJobTimeout(child: ChildProcess, id: string): void {
  pending.delete(id);
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  worker = null;
  ready = false;
}

/** 发送失败处理：清理定时器与待办任务 */
function handleSendFailure(
  id: string,
  timer: ReturnType<typeof setTimeout>,
  err: unknown,
  reject: (err: Error) => void,
): void {
  clearTimeout(timer);
  pending.delete(id);
  reject(err instanceof Error ? err : new Error(String(err)));
}

/** 发送任务到子进程并等待结果（含超时与发送失败处理） */
function sendJob(
  child: ChildProcess,
  id: string,
  payload: Record<string, unknown>,
  options: SendJobOptions,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      handleJobTimeout(child, id);
      reject(new Error(`[${options.timeoutLabel}] ${t('pipeline.jobTimeout', { timeoutMs: options.timeoutMs })}`));
    }, options.timeoutMs);

    pending.set(id, { resolve, reject, onProgress: options.onProgress, timer });

    try {
      child.send(payload);
    } catch (err) {
      handleSendFailure(id, timer, err, reject);
    }
  });
}

function dispatchJob(
  payload: Record<string, unknown>,
  timeoutMs: number,
  timeoutLabel: string,
  onProgress?: ProgressHandler,
): Promise<unknown> {
  ensurePipelineWorker();
  return waitUntilReady().then(() => {
    const id = String(payload.id);
    const child = worker;
    if (!child || !child.connected) {
      throw new Error(`[pipeline-host] ${t('pipeline.workerUnavailable')}`);
    }

    return sendJob(child, id, payload, { timeoutMs, timeoutLabel, onProgress });
  });
}

export async function runPipelineInWorker(
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean },
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PipelineReport> {
  const id = `pipeline-${Date.now()}-${++seq}`;
  const guardConfig = await readConfig().catch(() => ({ enabled: true, preCommit: true, prePush: true, blockOnCritical: true }));
  const report = await dispatchJob(
    { type: 'run', id, projectPath, options: { ...options, guardEnabled: guardConfig.enabled } },
    timeoutMs,
    'engine:runPipeline',
    onProgress,
  );
  return report as PipelineReport;
}

/** 重构检查走子进程，避免主进程 AST/扫盘导致 macOS 彩球 */
export async function runRefactorInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RefactorReport> {
  const id = `refactor-${Date.now()}-${++seq}`;
  const report = await dispatchJob(
    { type: 'runRefactor', id, projectPath },
    timeoutMs,
    'engine:runRefactor',
    onProgress,
  );
  return report as RefactorReport;
}

export async function runGuardInWorker(
  projectPath: string,
  options?: Record<string, unknown>,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const id = `guard-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runGuard', id, projectPath, options },
    timeoutMs,
    'engine:runGuard',
    onProgress,
  );
}

export async function runInspectInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const id = `inspect-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runInspect', id, projectPath },
    timeoutMs,
    'engine:runInspect',
    onProgress,
  );
}

export async function runSecurityInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const id = `security-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runSecurity', id, projectPath },
    timeoutMs,
    'engine:runSecurity',
    onProgress,
  );
}

export async function runGarbageCleanInWorker(
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
  timeoutMs = 120000,
): Promise<unknown> {
  const id = `garbage-clean-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runGarbageClean', id, projectPath, items },
    timeoutMs,
    'engine:garbageClean',
  );
}

export async function runGarbageRestoreInWorker(
  projectPath: string,
  batchId: string,
  timeoutMs = 120000,
): Promise<unknown> {
  const id = `garbage-restore-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runGarbageRestore', id, projectPath, batchId },
    timeoutMs,
    'engine:garbageRestore',
  );
}

export async function runPerformanceInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const id = `performance-${Date.now()}-${++seq}`;
  return dispatchJob(
    { type: 'runPerformance', id, projectPath },
    timeoutMs,
    'engine:runPerformance',
    onProgress,
  );
}

export function disposePipelineWorker(): void {
  rejectAll(new Error(`[pipeline-host] ${t('pipeline.shuttingDown')}`));
  if (worker && !worker.killed) {
    try {
      worker.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  worker = null;
  ready = false;
}
