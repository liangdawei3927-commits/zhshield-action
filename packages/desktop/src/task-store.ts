import { useCallback, useState, useSyncExternalStore } from 'react';
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
  // 第三个参数是 SSR/静态渲染快照：任务存储是模块级单例，服务端不订阅，返回同一快照即可。
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 指定 kind + 项目的最新任务（含已完成；无则 undefined） */
export function useTask(kind: TaskKind, projectPath: string): TaskInfo | undefined {
  const all = useTasks();
  return all.filter((t) => t.kind === kind && t.projectPath === projectPath).at(-1);
}

/** 任务类型默认操作文案（用于进度提示缺省值） */
export const TASK_KIND_DEFAULT_LABELS: Record<TaskKind, string> = {
  pipeline: 'task.kind.pipeline',
  inspect: 'task.kind.inspect',
  security: 'task.kind.security',
  garbage: 'task.kind.garbage',
  garbageClean: 'task.kind.garbageClean',
  garbageRestore: 'task.kind.garbageRestore',
  performance: 'task.kind.performance',
  guard: 'task.kind.guard',
  refactor: 'task.kind.refactor',
  deps: 'task.kind.deps',
  techdebt: 'task.kind.techdebt',
};

/** useTaskRun 的返回值：loading/排队/进度/状态文案 + 对应任务条目 */
export interface TaskRunState {
  loading: boolean;
  queued: boolean;
  /**
   * 排队位置（1 起；仅 queued 时有值）。
   * 按钮只显示「排队中…」纯状态词，位置归进度条文案（task.queuedLabel）。
   */
  queuePosition?: number;
  progress: number;
  /**
   * 「体检中... 42% · 正在检查 src/a.ts」这类**含进度与任务消息的整串**。
   *
   * ⚠️ 禁止接进按钮（loadingLabel）：按钮只许显示「体检中…」这类状态词，
   * 百分比与任务消息归进度条。域主操作按钮统一走 DomainActionButton，
   * 由 __tests__/domain-action-label.test.ts 锁住（页面里出现 progressLabel 即红）。
   */
  progressLabel: string;
  statusMessage: string;
  task: TaskInfo | undefined;
  /** 取消当前任务（用户点「停止」）。空闲时为 no-op，可安全接到按钮 onClick */
  cancel: () => void;
  /** 已发出取消、等任务中心推送确认：按钮据此显示「停止中…」并禁用防连点 */
  stopping: boolean;
}

/**
 * 取消任务。
 *
 * 主进程收到后立刻 awake 等待方（见 TaskManager.cancel 的 settle），UI 不等执行器
 * 收尾；执行器若不在宽限期内退出，会被终止（见 pipeline-host 的 cancelJob）。
 *
 * 失败不弹错：任务可能刚好跑完（cancel 返回 false），此时状态由任务中心推送纠正，
 * 对用户来说"已经结束了"与"刚停掉"结果相同，报错只会制造噪音。
 */
export function cancelTask(taskId: string): void {
  const run = window.electronAPI?.tasks?.cancel?.(taskId);
  void run?.catch(() => undefined);
}

/**
 * 派生单个扫描任务的运行状态：loading/排队/进度文案统一来自任务中心。
 * 页面按钮与进度提示用此 hook，避免本地 loading state 与任务中心脱节。
 */
export function useTaskRun(kind: TaskKind, projectPath: string): TaskRunState {
  const task = useTask(kind, projectPath);
  // 记录"用户已经为哪个任务点过停止"：从点击到任务中心推送 cancelled 之间有个
  // 几毫秒到几百毫秒的窗口，期间按钮必须显示「停止中…」并锁住，否则会连点出第二次取消。
  const [cancelRequestedFor, setCancelRequestedFor] = useState<string | null>(null);

  const activeId = task && (task.status === 'queued' || task.status === 'running') ? task.id : null;
  const stopping = activeId !== null && cancelRequestedFor === activeId;

  const cancel = useCallback(() => {
    if (!activeId || cancelRequestedFor === activeId) return;
    setCancelRequestedFor(activeId);
    cancelTask(activeId);
  }, [activeId, cancelRequestedFor]);

  const idle: TaskRunState = {
    loading: false,
    queued: false,
    progress: 0,
    progressLabel: '',
    statusMessage: '',
    task: undefined,
    cancel,
    stopping: false,
  };
  if (!task || activeId === null) return idle;

  // 忙态文案不区分触发来源（自动巡检/手动点击/首扫一律同一套）：
  // 任务在跑按钮就显示「巡检中…」，用户不需要知道也不该关心是谁扣的扳机。
  const base = t(TASK_KIND_DEFAULT_LABELS[kind]);
  if (task.status === 'queued') {
    const pos = task.queuePosition ?? '?';
    return {
      loading: true,
      queued: true,
      queuePosition: task.queuePosition,
      progress: 0,
      progressLabel: t('task.queuedLabel', { position: pos }),
      statusMessage: '',
      task,
      cancel,
      stopping,
    };
  }
  const percent = Math.min(Math.max(Math.round((task.progress || 0) * 100), 0), 100);
  const suffix = task.message && task.message.trim() ? ` · ${task.message.trim()}` : '';
  return {
    loading: true,
    queued: false,
    progress: task.progress || 0,
    progressLabel: t('task.runningLabel', { kind: base, percent, suffix }),
    statusMessage: task.message?.trim() ?? '',
    task,
    cancel,
    stopping,
  };
}
