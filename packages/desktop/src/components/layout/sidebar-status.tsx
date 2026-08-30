import { useEffect, useState } from 'react';
import { SectionTitle } from './sidebar-interactive';
import { BounceCard } from '../ui/Bounce';
import { useTasks, cancelTask } from '../../task-store';
import type { TaskInfo } from '../../types/electron';
import { useT } from '../../i18n';

/** 任务类型 i18n 键（任务中心 / 侧边栏共用），渲染处用 t(textKey) */
export const TASK_KIND_LABELS: Record<string, string> = {
  pipeline: 'layout.taskKind.pipeline',
  inspect: 'layout.taskKind.inspect',
  security: 'layout.taskKind.security',
  garbageClean: 'layout.taskKind.garbageClean',
  garbageRestore: 'layout.taskKind.garbageRestore',
  performance: 'layout.taskKind.performance',
  guard: 'layout.taskKind.guard',
  refactor: 'layout.taskKind.refactor',
};

const STATUS_LABELS: Record<string, string> = {
  queued: 'layout.taskStatus.queued',
  running: 'layout.taskStatus.running',
  done: 'layout.taskStatus.done',
  failed: 'layout.taskStatus.failed',
  cancelled: 'layout.taskStatus.cancelled',
};

/** 从工具可用性列表中筛出缺失工具 id */
function filterMissingTools(list: Array<{ id: string; available: boolean }>): string[] {
  return list.filter((t) => !t.available).map((t) => t.id);
}

/** 通过 IPC 加载工具可用性，回传缺失工具 id；返回取消函数 */
function loadMissingTools(onResult: (missing: string[]) => void): () => void {
  let cancelled = false;
  async function fetchAndFilter() {
    try {
      const list = await window.electronAPI?.getToolAvailability?.();
      if (!list || cancelled) return;
      onResult(filterMissingTools(list));
    } catch {
      // IPC 不可用时忽略
    }
  }
  void fetchAndFilter();
  return () => {
    cancelled = true;
  };
}

/** 外部工具可用性加载：返回缺失工具 id 列表 */
function useToolAvailability(): string[] {
  const [missingTools, setMissingTools] = useState<string[]>([]);

  useEffect(() => loadMissingTools(setMissingTools), [setMissingTools]);

  return missingTools;
}

/** 侧边栏引擎状态区：引擎运行状态 + 实时任务列表 + 外部工具降级提示 */
export function EngineStatusSection() {
  const missingTools = useToolAvailability();
  const tasks = useTasks();
  const t = useT();
  const activeTasks = tasks.filter((task) => task.status === 'queued' || task.status === 'running');

  return (
    <section>
      <SectionTitle
        label={t('layout.engineStatus')}
        icon={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${activeTasks.length > 0 ? 'bg-amber-500 animate-pulse' : 'bg-green-700'}`} />
          <span className="text-xs font-medium text-zh-ink">{activeTasks.length > 0 ? t('layout.engineBusy', { count: activeTasks.length }) : t('layout.engineIdle')}</span>
        </div>
        {activeTasks.length > 0 && (
          <div className="space-y-2">
            {activeTasks.map((task) => (
              <TaskStatusRow key={task.id} task={task} />
            ))}
          </div>
        )}
        {missingTools.length > 0 ? (
          <div className="text-[11px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
            <div className="font-medium">{t('layout.toolsDegraded', { tools: missingTools.join(', ') })}</div>
            <div className="text-amber-600/80 mt-0.5">{t('layout.toolsPathHint')}</div>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-zh-muted">{t('layout.subprocessIsolation')}</p>
        )}
      </BounceCard>
    </section>
  );
}

/** 单个任务的实时进度行 */
function TaskStatusRow({ task }: { task: TaskInfo }) {
  const t = useT();
  const textKey = TASK_KIND_LABELS[task.kind];
  const label = textKey ? t(textKey) : task.kind;
  const pct = Math.round(task.progress * 100);

  return (
    <div className="rounded-md border border-zh-line bg-zh-card/70 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zh-ink-2 truncate">
          {label}
          {task.status === 'queued' && task.queuePosition ? t('layout.queuePosition', { position: task.queuePosition }) : ''}
        </span>
        <button
          type="button"
          onClick={() => void cancelTask(task.id)}
          className="shrink-0 text-[10px] text-zh-muted hover:text-red-600"
          title={t('layout.cancelTask')}
        >
          {t('common.cancel')}
        </button>
      </div>
      <div className="mt-1 h-1 rounded-full bg-zh-panel overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-600 transition-all duration-200"
          style={{ width: `${task.status === 'running' ? Math.max(pct, 3) : pct}%` }}
        />
      </div>
      {task.message && task.status === 'running' && (
        <div className="mt-1 text-[10px] text-zh-muted truncate">{task.message}</div>
      )}
      {task.status === 'queued' && <div className="mt-0.5 text-[10px] text-zh-muted">{t(STATUS_LABELS[task.status])}</div>}
    </div>
  );
}
