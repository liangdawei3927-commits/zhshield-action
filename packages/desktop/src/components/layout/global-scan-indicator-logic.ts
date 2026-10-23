import type { TaskInfo } from '../../types/electron';

export function isActiveTask(task: TaskInfo): boolean {
  return task.status === 'running' || task.status === 'queued';
}

function newest(tasks: TaskInfo[]): TaskInfo | undefined {
  return tasks.reduce<TaskInfo | undefined>(
    (latest, task) => (!latest || task.startedAt >= latest.startedAt ? task : latest),
    undefined,
  );
}

/**
 * 选出全局指示器应展示的任务。
 * 产品规则：运行中优先于排队中（排队没有真实进度，不该抢走正在跑的那条），
 * 同状态下取 startedAt 最新者，保证多任务并发时展示「最近发起」的扫描。
 */
export function pickActiveTask(tasks: TaskInfo[]): TaskInfo | undefined {
  const active = tasks.filter(isActiveTask);
  return newest(active.filter((task) => task.status === 'running')) ?? newest(active);
}

/** 活动任务数量，用于"+N"角标（指示器只展示 1 条） */
export function countActiveTasks(tasks: TaskInfo[]): number {
  return tasks.filter(isActiveTask).length;
}
