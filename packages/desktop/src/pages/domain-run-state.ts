/**
 * 域扫描运行态的统一装配（domain-run-state.ts）
 *
 * ## 为什么有这层
 *
 * 七个域的逻辑 hook（dependency / tech-debt / refactor / security / performance /
 * guard / garbage）此前各自写一遍**逐字相同**的样板：
 *
 * ```ts
 * const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } =
 *   useTaskRun('<kind>', projectPath);
 * ...
 * return { loading, progress, statusMessage, queued, queuePosition, cancel, stopping, report, handleScan };
 * ```
 *
 * 八字段的 destructure 与 return 在七个文件里重复 —— 任何一处改名（2026-11-03 的
 * `progressMessage` → `statusMessage` 就是一次全仓改名）都要动七个文件，且极易漏改
 * 留下不一致。本模块把「任务中心状态 → 页面运行态」这一段收敛为单一实现，
 * 域 hook 只声明自己的报告类型与副作用。
 *
 * ## 命名口径（2026-11-03 起全仓统一）
 *
 *   · `loading`        —— 运行态（含排队中）
 *   · `statusMessage`  —— 进度文案（任务中心 task.message）
 *   · `progress`       —— 进度数值 0..1
 *   · `cancel` / `stopping` —— 取消动作与「停止中」确认态
 *
 * 历史别名 `progressMessage`（依赖/技术债域）与 `scanning`（重构域）已收敛到上述命名。
 */
import { useTaskRun } from '../task-store';
import type { TaskKind } from '../types/electron';

/** 域扫描运行态：任务中心派生的全部字段（与域无关） */
export interface DomainRunState {
  /** 运行中（含排队中） */
  loading: boolean;
  /** 进度数值 0..1 */
  progress: number;
  /** 进度文案（任务中心 task.message） */
  statusMessage: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  queued: boolean;
  /** 排队位置（1 起；仅 queued 时有值） */
  queuePosition?: number;
  /** 取消当前任务（用户点「停止」）：主进程立刻让等待方返回，UI 不等执行器收尾 */
  cancel: () => void;
  /** 已发出取消、等任务中心确认（按钮显示「停止中…」并禁用） */
  stopping: boolean;
}

/**
 * 从任务中心取出该域的运行态。
 *
 * 这是七个域 hook 唯一的任务中心入口 —— 字段名、口径、派生逻辑只此一份，
 * 域 hook 不再各自 destructure 八个字段再逐个透传。
 */
export function useDomainRunState(kind: TaskKind, projectPath: string): DomainRunState {
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } = useTaskRun(
    kind,
    projectPath,
  );
  return {
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
  };
}
