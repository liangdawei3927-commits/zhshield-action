/**
 * 子进程 IPC 发送工具
 *
 * 供流水线各阶段（编排 / 单引擎任务）向主进程转发进度与结果消息。
 */
import type { PipelineWorkerOutbound } from './pipeline-protocol';

export function send(msg: PipelineWorkerOutbound): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

export function progress(id: string, stage: string, message: string, pct: number): void {
  send({ type: 'progress', id, stage, message, progress: pct });
}
