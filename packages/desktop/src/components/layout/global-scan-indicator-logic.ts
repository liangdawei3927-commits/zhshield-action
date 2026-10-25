import type { TaskInfo } from '../../types/electron';

export function isActiveTask(task: TaskInfo): boolean {
  return task.status === 'running' || task.status === 'queued';
}

/**
 * 活动任务数量（运行中 + 排队中）。
 *
 * 当前唯一消费方：`useDailyAutoCheck` —— 已有活动任务时跳过本页的每日自动检查，
 * 避免与用户手动触发的扫描重复跑。
 *
 * ⚠️ 本文件原名 global-scan-indicator-logic，随右下角全局扫描浮窗（2026-10-26 下线）
 * 一并清理：浮窗专属的 `pickActiveTask`（选中要展示的那条任务）已删除，
 * 只留下上面对外仍有消费方的计数函数。
 */
export function countActiveTasks(tasks: TaskInfo[]): number {
  return tasks.filter(isActiveTask).length;
}
