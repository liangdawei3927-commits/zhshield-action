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
  | PipelineProgressMsg
  | PipelineResultMsg
  | PipelineErrorMsg
  | PipelineReadyMsg;

export interface PipelineRunMsg {
  type: 'run';
  id: string;
  projectPath: string;
  options?: { dryRun?: boolean; sop?: boolean };
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

export interface InspectRunMsg {
  type: 'runInspect';
  id: string;
  projectPath: string;
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

export interface PerformanceRunMsg {
  type: 'runPerformance';
  id: string;
  projectPath: string;
}

export type PipelineWorkerInbound =
  | PipelineRunMsg
  | RefactorRunMsg
  | GuardRunMsg
  | InspectRunMsg
  | SecurityRunMsg
  | GarbageCleanRunMsg
  | GarbageRestoreRunMsg
  | PerformanceRunMsg;

/** 将报告转为可跨进程传输的纯 JSON（Date → ISO 字符串） */
export function serializePipelineReport(report: unknown): unknown {
  return JSON.parse(JSON.stringify(report));
}
