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

/** 主进程 → 引擎子进程：取消指定任务 */
export interface PipelineCancelMsg {
  type: 'cancel';
  id: string;
}

/**
 * 取消错误的统一标记（跨进程、跨语言稳定）。
 *
 * 用户点「停止」不是故障，但取消走的是 IPC reject 通道，和真实失败同一条路。
 * 若靠本地化文案（「任务已取消」/「Task cancelled」）来区分，任何一次
 * 文案改动或语言切换都会让取消退化成红色失败页。故用固定 ASCII 标记做判据：
 * - 主进程 reject 时加前缀（见 pipeline-host / task-manager）
 * - 渲染层 services/cancel-error.ts 用同一字面量识别
 * 两处一致性由 __tests__/task-cancelled-silent.test.ts 与
 * task-cancel-reach-executor.test.ts 锁住。
 */
export const CANCELLED_ERR_TAG = '[cancelled]';

/**
 * 判断一个错误是否是「用户主动取消」。
 *
 * 取消走的是与真实故障同一条 reject 通道（见 task-manager 的 settle）。handler 的
 * 降级兜底（catch 里返回空报告 / 带 error 的失败报告）若把它吞掉，用户点「停止」
 * 后会看到「体检失败」+ 一行红色错误文案 —— 把用户的主动操作报成系统故障。
 *
 * 判据只用固定 ASCII 标记，不依赖本地化文案（语言切换/措辞改动都不会让判据失效）。
 */
export function isCancelledFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes(CANCELLED_ERR_TAG);
}

/**
 * handler 降级兜底前的「取消短路」：取消必须原样抛给渲染层。
 *
 * 抛出去后由渲染层 services/cancel-error.ts 用同一标记识别并**静默处理**
 * （不落失败页、保留已有报告）。真实故障不走这里，仍按各 handler 既有的降级
 * 兜底返回（空报告 / 失败结果），行为不变。
 *
 * ⚠️ 每个会 `await manager.waitFor(...)` 的 handler 都必须在 catch 的**第一句**
 * 调它 —— 漏一个，那个域就会把用户的取消说成失败。
 */
export function rethrowIfCancelled(err: unknown): void {
  if (isCancelledFailure(err)) {
    throw err instanceof Error ? err : new Error(String(err));
  }
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
  | PerformanceRunMsg
  | PipelineCancelMsg;

/** 将报告转为可跨进程传输的纯 JSON（Date → ISO 字符串） */
export function serializePipelineReport(report: unknown): unknown {
  return JSON.parse(JSON.stringify(report));
}
