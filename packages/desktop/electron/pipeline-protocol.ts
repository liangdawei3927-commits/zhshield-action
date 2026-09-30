/** 主进程 ↔ 引擎子进程 IPC 协议（可序列化） */

export interface PipelineProgressMsg {
  type: 'progress';
  id: string;
  stage: string;
  message: string;
  progress: number;
}

/** 引擎子进程 → 主进程：任务完成并回传最终报告 */
export interface PipelineResultMsg {
  type: 'result';
  id: string;
  report: unknown;
}

/** 引擎子进程 → 主进程：任务失败并回传错误信息 */
export interface PipelineErrorMsg {
  type: 'error';
  id: string;
  error: string;
}

/** 引擎子进程 → 主进程：worker 启动就绪（握手信号） */
export interface PipelineReadyMsg {
  type: 'ready';
}

/** 引擎子进程 → 主进程 的全部消息联合类型（可序列化） */
export type PipelineWorkerOutbound =
  PipelineProgressMsg | PipelineResultMsg | PipelineErrorMsg | PipelineReadyMsg;

/** 主进程 → 引擎子进程：发起巡检（options 可携带 dryRun / sop / 门禁开关） */
export interface PipelineRunMsg {
  type: 'run';
  id: string;
  projectPath: string;
  options?: { dryRun?: boolean; sop?: boolean; guardEnabled?: boolean };
}

/** 主进程 → 引擎子进程：发起重构扫描 */
export interface RefactorRunMsg {
  type: 'runRefactor';
  id: string;
  projectPath: string;
}

/** 主进程 → 引擎子进程：发起门禁检查（options 为门禁开关等透传参数） */
export interface GuardRunMsg {
  type: 'runGuard';
  id: string;
  projectPath: string;
  options?: Record<string, unknown>;
}

/** 主进程 → 引擎子进程：发起安全扫描 */
export interface SecurityRunMsg {
  type: 'runSecurity';
  id: string;
  projectPath: string;
}

/** 主进程 → 引擎子进程：清理用户确认的垃圾条目（items 为待删文件清单） */
export interface GarbageCleanRunMsg {
  type: 'runGarbageClean';
  id: string;
  projectPath: string;
  items: Array<{ id: string; path: string; size: number; type: string }>;
}

/** 主进程 → 引擎子进程：按批次恢复（回滚）已清理的垃圾条目 */
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

/** 主进程 → 引擎子进程：发起性能扫描 */
export interface PerformanceRunMsg {
  type: 'runPerformance';
  id: string;
  projectPath: string;
}

/** 主进程 → 引擎子进程 的全部命令联合类型（可序列化） */
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
