/**
 * Profile worker 线程宿主（profile-host.ts）
 *
 * 用 worker_threads 承载项目画像 / 文件扫描类文件系统工作，
 * 主进程只做 RPC 转发，保持 UI 线程可响应（避免 macOS 彩球）。
 *
 * 可靠性语义：
 * - 每个请求带自增 id，响应按 id 关联；
 * - 每个请求有超时，超时即终止当前 worker（卡死的同步扫盘无法中断，只能换线程）；
 * - worker 崩溃 / 出错时拒绝所有在途请求并自动重启；
 * - 连续失败达到上限后熔断：不再重启，直接快速失败（调用方优雅降级，渲染层永不挂起）。
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { ScoringProfileResult } from '@zh/fingerprint';
import type { ProfileWorkerRequest, ProfileWorkerResponse } from './profile-worker';

const WORKER_SCRIPT = path.join(__dirname, 'profile-worker.js');
const DEFAULT_TIMEOUT_MS = 120_000;
/** 连续基础设施失败上限：达到后熔断，停止重启 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProfileJob {
  type: ProfileWorkerRequest['type'];
  projectPath: string;
  options?: ProfileWorkerRequest['options'];
}

let worker: Worker | null = null;
let seq = 0;
let consecutiveFailures = 0;
const pending = new Map<string, PendingRequest>();

function rejectAll(err: Error): void {
  for (const [, job] of pending) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  pending.clear();
}

/** 记录一次基础设施失败；返回是否已触发熔断 */
function noteFailure(): boolean {
  consecutiveFailures += 1;
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

function handleWorkerError(err: Error): void {
  console.error('[profile-host] worker 错误:', err.message);
  worker = null;
  const tripped = noteFailure();
  rejectAll(
    tripped
      ? new Error(
          `[profile-host] profile worker 连续失败 ${consecutiveFailures} 次，已熔断: ${err.message}`,
        )
      : err,
  );
}

function handleWorkerExit(code: number): void {
  if (worker === null) return; // 已由 error/timeout 路径处理
  worker = null;
  if (pending.size === 0) return;
  const tripped = noteFailure();
  rejectAll(
    new Error(
      `[profile-host] profile worker 异常退出 code=${code}${tripped ? `（连续失败 ${consecutiveFailures} 次，已熔断）` : ''}`,
    ),
  );
}

function spawnWorker(): Worker {
  const w = new Worker(WORKER_SCRIPT);
  w.on('message', (raw: ProfileWorkerResponse) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return;
    const job = pending.get(raw.id);
    if (!job) return;
    pending.delete(raw.id);
    clearTimeout(job.timer);
    if (raw.ok) {
      consecutiveFailures = 0; // 成功响应重置熔断计数
      job.resolve(raw.result);
    } else {
      // 业务级失败（如 projectPath 无效）：worker 本身健康，不计入熔断
      job.reject(new Error(`[profile-worker] ${raw.error}`));
    }
  });
  w.on('error', handleWorkerError);
  w.on('exit', (code) => handleWorkerExit(code));
  return w;
}

function ensureWorker(): Worker {
  if (!worker) worker = spawnWorker();
  return worker;
}

function terminateWorker(): void {
  const w = worker;
  worker = null;
  if (!w) return;
  w.terminate().catch((err: unknown) => {
    console.warn(
      '[profile-host] 终止 worker 失败:',
      err instanceof Error ? err.message : String(err),
    );
  });
}

function sendRequest(w: Worker, req: ProfileWorkerRequest, job: PendingRequest): void {
  try {
    w.postMessage(req);
  } catch (err) {
    pending.delete(req.id);
    clearTimeout(job.timer);
    job.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * 向 profile worker 发送请求并等待结果。
 * 超时 / 崩溃 / 发送失败都会以明确错误 reject —— 永不挂起。
 */
export function runInProfileWorker<T>(job: ProfileJob, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const id = `${job.type}-${Date.now()}-${++seq}`;
  const req: ProfileWorkerRequest = {
    id,
    type: job.type,
    projectPath: job.projectPath,
    options: job.options,
  };
  const w = ensureWorker();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      terminateWorker(); // 卡死线程只能终止；下次请求自动重启
      const tripped = noteFailure();
      reject(
        new Error(
          `[profile-host] profile worker 响应超时（${timeoutMs}ms）${tripped ? `，连续失败 ${consecutiveFailures} 次已熔断` : ''}`,
        ),
      );
    }, timeoutMs);

    const entry: PendingRequest = {
      resolve: (result) => resolve(result as T),
      reject,
      timer,
    };
    pending.set(id, entry);
    sendRequest(w, req, entry);
  });
}

/** 技术债对外接口扫描（原 engines.ts 主线程同步扫盘，移入 worker） */
export function collectExposedFilesInWorker(
  projectPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  return runInProfileWorker<string[]>({ type: 'collectExposedFiles', projectPath }, timeoutMs);
}

/** @zh/pipeline 项目画像识别（原主线程同步 fs，移入 worker） */
export function detectProfileInWorker(
  projectPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return runInProfileWorker<unknown>({ type: 'detectProfile', projectPath }, timeoutMs);
}

/** @zh/fingerprint 完整画像 + 问题集 + 漂移（engine:runProfile 彩球修复主体） */
export function runProfileInWorker(projectPath: string, timeoutMs = 5 * 60_000): Promise<unknown> {
  return runInProfileWorker<unknown>({ type: 'runProfile', projectPath }, timeoutMs);
}

/** @zh/fingerprint 同步画像（ScoringProjectProfile + warnings，原主进程同步调用，移入 worker） */
export function runProfileSyncInWorker(
  projectPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScoringProfileResult> {
  return runInProfileWorker<ScoringProfileResult>({ type: 'profileSync', projectPath }, timeoutMs);
}
