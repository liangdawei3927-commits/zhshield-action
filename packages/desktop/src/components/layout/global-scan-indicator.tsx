import { useNavigation } from '../../contexts/NavigationContext';
import { useT } from '../../i18n';
import { TASK_KIND_DEFAULT_LABELS, useTasks } from '../../task-store';
import { DomainScanProgress } from '../business/DomainScanProgress';
import { requestDetailIntent } from '../../hooks/nav-detail-intent';
import { countActiveTasks, pickActiveTask } from './global-scan-indicator-logic';
import { navIdForTaskKind } from './nav-items';

/**
 * 全局扫描进度指示器：跨分类常驻右下角，展示当前活动任务。
 *
 * 只在「当前分类页不是该任务的归属页」时出现 —— 归属页已由 PageShell/ReportShell
 * 展示同一任务，重复显示会让用户以为跑了两个扫描。
 */
export function GlobalScanIndicator() {
  const t = useT();
  const nav = useNavigation();
  const tasks = useTasks();
  const task = pickActiveTask(tasks);
  if (!task) return null;

  const navId = navIdForTaskKind(task.kind);
  if (navId !== undefined && nav?.currentPage === navId) return null;

  const extra = countActiveTasks(tasks) - 1;
  const kindName = t(TASK_KIND_DEFAULT_LABELS[task.kind] || task.kind);
  const label =
    task.status === 'queued'
      ? t('task.queuedLabel', { position: task.queuePosition ?? '?' })
      : [kindName, task.message?.trim()].filter(Boolean).join(' · ');

  const shellClass =
    'fixed bottom-4 right-4 z-40 w-[268px] rounded-xl border border-zh-line bg-zh-card shadow-lg px-4 py-3 flex flex-col gap-2 animate-[fadeInUp_0.25s_ease-out] text-left';

  const body = (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-semibold text-zh-ink truncate">{kindName}</span>
        {extra > 0 && (
          <span className="shrink-0 text-[11px] font-semibold text-brand-700 bg-brand-50 rounded-full px-1.5">
            +{extra}
          </span>
        )}
      </div>
      <DomainScanProgress
        loading
        progress={task.progress}
        label={label}
        className="w-full flex justify-center"
      />
    </>
  );

  if (navId === undefined) {
    return (
      <div
        className={shellClass}
        role="status"
        aria-live="polite"
        data-testid="global-scan-indicator"
      >
        {body}
      </div>
    );
  }

  // 点进度条的语义是「我要看这条任务的结果」，不是「我要逛这个分类」：
  // 走后登记一次直达详情意图，归属页挂载时据此直接展开详情（否则要再点一次详情图标）
  const openTaskOwner = () => {
    requestDetailIntent(navId);
    nav?.navigate(navId);
  };

  return (
    <button
      type="button"
      onClick={openTaskOwner}
      title={kindName}
      aria-label={kindName}
      className={`${shellClass} cursor-pointer hover:shadow-xl transition-shadow`}
      data-testid="global-scan-indicator"
    >
      {body}
    </button>
  );
}
