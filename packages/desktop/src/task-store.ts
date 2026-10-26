import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@zh/i18n';
import type { ScoreDimension } from '@zh/shared';
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

/** 指定 kind + 项目的最新任务（含已完成；无则 undefined）。kind 为 undefined 视为无任务 */
export function useTask(kind: TaskKind | undefined, projectPath: string): TaskInfo | undefined {
  const all = useTasks();
  if (!kind) return undefined;
  return all.filter((t) => t.kind === kind && t.projectPath === projectPath).at(-1);
}

/**
 * 域/维度名 → 产出该域数据的任务类型。
 * 两套命名并存：评分维度（quality/gate/dependencies…）与域报告名（inspect/deps…），
 * 指向同一批任务。sentinel（持续监控）与 backup（独立备份链路）无对应任务。
 */
const DOMAIN_TASK_KIND: Record<string, TaskKind> = {
  quality: 'pipeline',
  inspect: 'pipeline',
  gate: 'guard',
  guard: 'guard',
  security: 'security',
  secrets: 'security',
  dependencies: 'deps',
  deps: 'deps',
  techdebt: 'techdebt',
  refactor: 'refactor',
  performance: 'performance',
  garbage: 'garbage',
};

/** 域名（评分维度或域报告名）→ 产出它的任务类型；无对应任务返回 undefined */
export function taskKindForDomain(domain: string): TaskKind | undefined {
  return DOMAIN_TASK_KIND[domain];
}

function isTerminalStatus(status: TaskInfo['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** 观察帧：上一帧看到的任务 id 与其是否已是终态 */
export interface TaskSettleObservation {
  id: string;
  settled: boolean;
}

/**
 * 纯谓词：任务是「刚落入终态」（上一帧同 id 尚未终态）→ 应触发刷新。
 * - 挂载时已是终态（prev 为 null）→ 历史结果，不触发（页面挂载本身就会拉数据）；
 * - 同一任务终态后的重复广播（prev.settled=true）→ 不重复触发；
 * - 换了新任务 id → 从它非终态时开始观察，落定才触发。
 */
export function shouldBumpSettledTick(
  prev: TaskSettleObservation | null,
  task: Pick<TaskInfo, 'id' | 'status'>,
): boolean {
  if (!isTerminalStatus(task.status)) return false;
  return prev !== null && prev.id === task.id && !prev.settled;
}

/** 项目级观察状态：ready 前登记的历史终态不触发；settledIds 去重重复广播 */
export interface ProjectSettleState {
  ready: boolean;
  settledIds: Set<string>;
}

/**
 * 纯函数（吸收式）：把项目下已落定任务并入观察状态。
 * 返回 true 表示出现了「ready 之后新落入终态」的任务 → 应触发刷新。
 * 初始列表是异步拉回的，不能用「第一次调用」判断历史——以列表非空后 ready=true 划界。
 */
export function absorbProjectSettled(
  state: ProjectSettleState,
  tasks: readonly TaskInfo[],
  projectPath: string,
): boolean {
  let changed = false;
  for (const task of tasks) {
    if (task.projectPath !== projectPath) continue;
    if (!isTerminalStatus(task.status)) continue;
    if (state.settledIds.has(task.id)) continue;
    state.settledIds.add(task.id);
    if (state.ready) changed = true;
  }
  if (tasks.length > 0) state.ready = true;
  return changed;
}

/**
 * P0-1：任务落定信号（tick）。
 *
 * 缺陷背景：各域页面的分数/报告 hook 只在挂载时读一次（切 tab 才重挂载重读），
 * 后台任务（自动巡检/任务中心/其他页面发起）完成后，当前页面停留在 `--` 或旧分数。
 *
 * 本 hook 观察 (kind, projectPath) 的最新任务：当其状态从非终态**变为**终态
 * （done/failed/cancelled）时返回值 +1。页面把它接进数据 hook 的 refreshKey，
 * 即可在任务完成瞬间自动重拉分数，无需切 tab。
 *
 * 语义细节：
 * - 挂载时任务已是终态（历史结果）不触发 tick——页面挂载本身就会拉一次数据，
 *   不能让每个带历史任务的页面都多跑一次重复请求；
 * - 同一任务的终态后续推送（重复广播）不重复触发。
 */
export function useTaskSettledTick(kind: TaskKind | undefined, projectPath: string): number {
  const task = useTask(kind, projectPath);
  const [tick, setTick] = useState(0);
  // 上一帧观察到的任务快照：用于判定「终态是刚发生的」还是「挂载时就如此」
  const known = useRef<{ id: string; settled: boolean } | null>(null);

  useEffect(() => {
    if (!task) return;
    const prev = known.current;
    known.current = { id: task.id, settled: isTerminalStatus(task.status) };
    if (shouldBumpSettledTick(prev, task)) {
      setTick((n) => n + 1);
    }
  }, [task]);

  return tick;
}

/** 按评分维度/域报告名观察落定信号（内部换算成任务类型）。无对应任务的维度恒 0 */
export function useDimensionSettledTick(dimension: ScoreDimension, projectPath: string): number {
  return useTaskSettledTick(taskKindForDomain(dimension), projectPath);
}

/**
 * 项目级落定信号：该项目**任意**任务落入终态时 +1。
 * 供跨域聚合视图（评分总览等）使用——聚合吃所有域，任何一个域跑完都该重拉。
 * 挂载/订阅时已存在的历史终态任务不触发（与 useTaskSettledTick 同语义）。
 */
export function useProjectSettledTick(projectPath: string): number {
  const all = useTasks();
  const [tick, setTick] = useState(0);
  // ready=false 期间观察到的终态任务都是挂载时的历史数据，只登记不触发；
  // 初始列表是异步拉回来的，不能用「第一次 effect」判断（那时列表还是空的）。
  const known = useRef<ProjectSettleState>({ ready: false, settledIds: new Set() });

  useEffect(() => {
    if (absorbProjectSettled(known.current, all, projectPath)) {
      setTick((n) => n + 1);
    }
  }, [all, projectPath]);

  return tick;
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
  /** 忙态已用时（排队+执行合计），如「已用时 1:23」；空闲为空串 */
  elapsedText: string;
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

/** 秒 → 「m:ss」（不足 1 分钟显示 0:ss） */
export function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 忙态计时：active 期间每秒走字，返回自 startedAt 起的秒数。
 * P2-8：扫描点击后可能 1–10 分钟才出结果，没有耗时时长用户无法区分
 * 「在跑」和「卡死」。inactive 时不挂定时器、返回 0。
 */
function useElapsedSeconds(startedAt: string | undefined, active: boolean): number {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  if (!active || !startedAt) return 0;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

export function useTaskRun(kind: TaskKind, projectPath: string): TaskRunState {
  const task = useTask(kind, projectPath);
  // 记录"用户已经为哪个任务点过停止"：从点击到任务中心推送 cancelled 之间有个
  // 几毫秒到几百毫秒的窗口，期间按钮必须显示「停止中…」并锁住，否则会连点出第二次取消。
  const [cancelRequestedFor, setCancelRequestedFor] = useState<string | null>(null);

  const activeId = task && (task.status === 'queued' || task.status === 'running') ? task.id : null;
  const stopping = activeId !== null && cancelRequestedFor === activeId;
  const elapsedText = t('task.elapsedLabel', {
    time: formatElapsed(useElapsedSeconds(task?.startedAt, activeId !== null)),
  });

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
    elapsedText: '',
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
      statusMessage: elapsedText,
      elapsedText,
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
    // 任务消息（阶段说明）+ 已用时：进度条文案完整形态「正在检查 src/a.ts · 已用时 1:23」
    statusMessage: [task.message?.trim(), elapsedText].filter(Boolean).join(' · '),
    elapsedText,
    task,
    cancel,
    stopping,
  };
}
