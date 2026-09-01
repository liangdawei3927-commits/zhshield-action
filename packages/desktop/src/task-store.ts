import { useSyncExternalStore } from 'react';
import { t } from '@zh/i18n';
import type { TaskInfo, TaskKind } from './types/electron';

const tasks = new Map<string, TaskInfo>();
let snapshot: TaskInfo[] = [];
const listeners = new Set<() => void>();
let initialized = false;

function emit(): void {
  snapshot = [...tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!initialized) {
    initialized = true;
    window.electronAPI?.tasks
      ?.list?.()
      .then((list) => {
        for (const t of list) tasks.set(t.id, t);
        emit();
      })
      .catch(() => {});
    window.electronAPI?.tasks?.onChanged?.((task) => {
      tasks.set(task.id, task);
      emit();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): TaskInfo[] {
  return snapshot;
}

export function useTasks(): TaskInfo[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 指定 kind + 项目的最新任务（含已完成；无则 undefined） */
export function useTask(kind: TaskKind, projectPath: string): TaskInfo | undefined {
  const all = useTasks();
  return all.filter((t) => t.kind === kind && t.projectPath === projectPath).at(-1);
}

export function startTask(
  kind: TaskKind,
  projectPath: string,
  options?: Record<string, unknown>,
): Promise<TaskInfo> {
  const api = window.electronAPI?.tasks;
  if (!api) return Promise.reject(new Error(t('task.schedulerUnavailable')));
  return api.start(kind, projectPath, options);
}

export function cancelTask(id: string): Promise<boolean> {
  const api = window.electronAPI?.tasks;
  if (!api) return Promise.resolve(false);
  return api.cancel(id);
}

/** 任务类型默认操作文案（用于进度提示缺省值） */
export const TASK_KIND_DEFAULT_LABELS: Record<TaskKind, string> = {
  pipeline: 'task.kind.pipeline',
  inspect: 'task.kind.inspect',
  security: 'task.kind.security',
  garbageClean: 'task.kind.garbageClean',
  garbageRestore: 'task.kind.garbageRestore',
  performance: 'task.kind.performance',
  guard: 'task.kind.guard',
  refactor: 'task.kind.refactor',
};

export interface TaskRunState {
  loading: boolean;
  queued: boolean;
  progress: number;
  progressLabel: string;
  task: TaskInfo | undefined;
}

/**
 * 派生单个扫描任务的运行状态：loading/排队/进度文案统一来自任务中心。
 * 页面按钮与进度提示用此 hook，避免本地 loading state 与任务中心脱节。
 */
export function useTaskRun(kind: TaskKind, projectPath: string): TaskRunState {
  const task = useTask(kind, projectPath);
  const idle: TaskRunState = {
    loading: false,
    queued: false,
    progress: 0,
    progressLabel: '',
    task: undefined,
  };
  if (!task || (task.status !== 'queued' && task.status !== 'running')) return idle;

  const base = t(TASK_KIND_DEFAULT_LABELS[kind]);
  if (task.status === 'queued') {
    const pos = task.queuePosition ?? '?';
    return {
      loading: true,
      queued: true,
      progress: 0,
      progressLabel: t('task.queuedLabel', { position: pos }),
      task,
    };
  }
  const percent = Math.min(Math.max(Math.round((task.progress || 0) * 100), 0), 100);
  const suffix = task.message && task.message.trim() ? ` · ${task.message.trim()}` : '';
  return {
    loading: true,
    queued: false,
    progress: task.progress || 0,
    progressLabel: t('task.runningLabel', { kind: base, percent, suffix }),
    task,
  };
}
