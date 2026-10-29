/**
 * Pipeline / Refactor 子进程宿主（对外入口）
 *
 * 在 Electron 主进程中 fork 独立 Node 子进程执行体检与重构，
 * 主进程只做消息转发，保持 UI 线程可响应（避免 macOS 彩球）。
 *
 * 按功能拆分：状态核心（worker 生命周期 / 任务表 / 取消翻译）见
 * pipeline-host-core.ts，各引擎调用门面见 pipeline-runs.ts。
 * 本文件保留原导入路径，task-manager / main / 测试无需改动。
 */
export {
  ensurePipelineWorker,
  preheatPipelineWorker,
  cancelJob,
  disposePipelineWorker,
} from './pipeline-host-core';
export type { ProgressHandler, WorkerRunOptions } from './pipeline-host-core';
export {
  runPipelineInWorker,
  runRefactorInWorker,
  runGuardInWorker,
  runSecurityInWorker,
  runGarbageScanInWorker,
  runGarbageCleanInWorker,
  runGarbageRestoreInWorker,
  runPerformanceInWorker,
} from './pipeline-runs';
