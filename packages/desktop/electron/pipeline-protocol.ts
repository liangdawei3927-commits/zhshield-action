/** 主进程 ↔ 引擎子进程 IPC 协议（可序列化） */

export interface PipelineProgressMsg {
  type: 'progress';
  id: string;
  stage: string;
  message: string;
  progress: number;
}

export interface PipelineResultMsg {
  type: 'result';
  id: string;
  report: unknown;
}

export interface PipelineErrorMsg {
  type: 'error';
  id: string;
  error: string;
}

export interface PipelineReadyMsg {
  type: 'ready';
}

export type PipelineWorkerOutbound =
  PipelineProgressMsg | PipelineResultMsg | PipelineErrorMsg | PipelineReadyMsg;

export interface PipelineRunMsg {
  type: 'run';
  id: string;
  projectPath: string;
  options?: { dryRun?: boolean; sop?: boolean; guardEnabled?: boolean };
}

export interface RefactorRunMsg {
  type: 'runRefactor';
  id: string;
  projectPath: string;
}

export interface GuardRunMsg {
  type: 'runGuard';
  id: string;
  projectPath: string;
  options?: Record<string, unknown>;
}

export interface SecurityRunMsg {
  type: 'runSecurity';
  id: string;
  projectPath: string;
}

export interface GarbageCleanRunMsg {
  type: 'runGarbageClean';
  id: string;
  projectPath: string;
  items: Array<{ id: string; path: string; size: number; type: string }>;
}

export interface GarbageRestoreRunMsg {
  type: 'runGarbageRestore';
  id: string;
  projectPath: string;
  batchId: string;
}

/** 垃圾清理扫描（T5）：垃圾清理域自有通道，不借调安全引擎 */
export interface GarbageScanRunMsg {
  type: 'runGarbageScan';
  id: string;
  projectPath: string;
}

export interface PerformanceRunMsg {
  type: 'runPerformance';
  id: string;
  projectPath: string;
}

export type PipelineWorkerInbound =
  | PipelineRunMsg
  | RefactorRunMsg
  | GuardRunMsg
  | SecurityRunMsg
  | GarbageCleanRunMsg
  | GarbageRestoreRunMsg
  | GarbageScanRunMsg
  | PerformanceRunMsg;

/** 将报告转为可跨进程传输的纯 JSON（Date → ISO 字符串） */
export function serializePipelineReport(report: unknown): unknown {
  return JSON.parse(JSON.stringify(report));
}
