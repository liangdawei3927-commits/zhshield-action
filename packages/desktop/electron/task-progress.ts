/**
 * 任务进度回调（跨进程无关）
 *
 * 由 TaskManager 的 runner 注入给域处理器，用于在**主进程内执行**的扫描任务上报进度。
 * 与 `pipeline-ipc.progress`（子进程 → 主进程消息）区分：这里是同进程内的函数调用，
 * pct 统一为 0..1，换算成百分比只在渲染层 `DomainScanProgress` 一处发生。
 */
export type TaskProgressReporter = (stage: string, message: string, pct: number) => void;
