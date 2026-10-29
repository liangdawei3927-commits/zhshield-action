/**
 * 各引擎调用的子进程门面（从 pipeline-host.ts 拆出的薄封装层）
 *
 * 只负责组装 payload 与默认超时，状态管理与取消翻译见 pipeline-host-core.ts。
 */
import type { PipelineReport } from '@zh/pipeline';
import type { RefactorReport } from '@zh/refactor';
import {
  DEFAULT_TIMEOUT_MS,
  dispatchJob,
  type ProgressHandler,
  type WorkerRunOptions,
} from './pipeline-host-core';
import { readConfig } from './ipc/guard-config';

/** 任务内部序号（与任务中心的 task.id 序号是两套，互不影响） */
let seq = 0;

export async function runPipelineInWorker(
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean },
  runOptions?: WorkerRunOptions,
): Promise<PipelineReport> {
  const { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, cancelKey } = runOptions ?? {};
  const id = `pipeline-${Date.now()}-${++seq}`;
  const guardConfig = await readConfig().catch(() => ({
    enabled: true,
    preCommit: true,
    prePush: true,
    blockOnCritical: true,
  }));
  const report = await dispatchJob({
    payload: {
      type: 'run',
      id,
      projectPath,
      options: { ...options, guardEnabled: guardConfig.enabled },
    },
    timeoutMs,
    timeoutLabel: 'engine:runPipeline',
    onProgress,
    cancelKey,
  });
  return report as PipelineReport;
}

/** 重构检查走子进程，避免主进程 AST/扫盘导致 macOS 彩球 */
export async function runRefactorInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelKey?: string,
): Promise<RefactorReport> {
  const id = `refactor-${Date.now()}-${++seq}`;
  const report = await dispatchJob({
    payload: { type: 'runRefactor', id, projectPath },
    timeoutMs,
    timeoutLabel: 'engine:runRefactor',
    onProgress,
    cancelKey,
  });
  return report as RefactorReport;
}

export async function runGuardInWorker(
  projectPath: string,
  options?: Record<string, unknown>,
  runOptions?: WorkerRunOptions,
): Promise<unknown> {
  const { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, cancelKey } = runOptions ?? {};
  const id = `guard-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runGuard', id, projectPath, options },
    timeoutMs,
    timeoutLabel: 'engine:runGuard',
    onProgress,
    cancelKey,
  });
}

export async function runSecurityInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelKey?: string,
): Promise<unknown> {
  const id = `security-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runSecurity', id, projectPath },
    timeoutMs,
    timeoutLabel: 'engine:runSecurity',
    onProgress,
    cancelKey,
  });
}

/** 垃圾清理扫描（T5）：文件系统检测器 + garbage 域 SOP 规则，不借调安全引擎 */
export async function runGarbageScanInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelKey?: string,
): Promise<unknown> {
  const id = `garbage-scan-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runGarbageScan', id, projectPath },
    timeoutMs,
    timeoutLabel: 'engine:runGarbageScan',
    onProgress,
    cancelKey,
  });
}

export async function runGarbageCleanInWorker(
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
  timeoutMs = 120000,
  cancelKey?: string,
): Promise<unknown> {
  const id = `garbage-clean-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runGarbageClean', id, projectPath, items },
    timeoutMs,
    timeoutLabel: 'engine:garbageClean',
    cancelKey,
  });
}

export async function runGarbageRestoreInWorker(
  projectPath: string,
  batchId: string,
  timeoutMs = 120000,
  cancelKey?: string,
): Promise<unknown> {
  const id = `garbage-restore-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runGarbageRestore', id, projectPath, batchId },
    timeoutMs,
    timeoutLabel: 'engine:garbageRestore',
    cancelKey,
  });
}

export async function runPerformanceInWorker(
  projectPath: string,
  onProgress?: ProgressHandler,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelKey?: string,
): Promise<unknown> {
  const id = `performance-${Date.now()}-${++seq}`;
  return dispatchJob({
    payload: { type: 'runPerformance', id, projectPath },
    timeoutMs,
    timeoutLabel: 'engine:runPerformance',
    onProgress,
    cancelKey,
  });
}
