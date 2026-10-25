import { useEffect, useRef, useState } from 'react';
import { useTasks } from '../task-store';
import type { TaskKind } from '../types/electron';
import { countActiveTasks } from '../components/layout/global-scan-indicator-logic';
import {
  AUTO_DEFER_MAX_MS,
  dailyAutoKey,
  needsDailyRun,
  ranToday,
  shouldDeferAutoRun,
} from './daily-auto-check-logic';

/** 读取今日自动检查记录（localStorage 不可用（极少见）→ 视为无记录，仍触发） */
function readStoredAuto(scope: string, projectPath: string): string | null {
  try {
    return localStorage.getItem(dailyAutoKey(scope, projectPath));
  } catch {
    return null;
  }
}

/** 写入今日自动检查记录（写不进也照样跑，只是同日再进页面会多跑一次） */
function writeStoredAuto(scope: string, projectPath: string, stamp: string): void {
  try {
    localStorage.setItem(dailyAutoKey(scope, projectPath), stamp);
  } catch {
    /* 写不进也照样跑 */
  }
}

/**
 * 每天首次进入页面时自动触发一次回调（体检页 / 代码重构页共用，无需用户配置）。
 *
 * ⚠️ 不是后台定时器：App 条件渲染下定时器只在页面挂载期间存在，因此触发时机
 * 是「进入页面时发现今天还没跑过」（判定与去重见 daily-auto-check-logic.ts，
 * 记录持久化在 localStorage）。页面空态文案须与此一致，不得再写"每日 0 点"。
 *
 * ⚠️ 必须让路（2026-10-25）：主进程并发上限只有 2（task-manager.ts 的 MAX_CONCURRENT），
 * 体检页 + 重构页各自动跑一次正好占满，此后用户点任何主操作按钮都只能排队。
 * 因此改为「有空闲槽位才跑」：系统有活动任务就延后，等到上限仍未空闲则放弃本次，
 * 且**不写今日记录**（下次进页面再试 —— 写记录等于宣称"今天查过了"，实际没查）。
 *
 * @param taskKind 本页对应的任务类型：用于识别"今天是否已经跑过"（含用户手动触发的那次），
 *                 避免等待期间用户自己点过按钮后又被自动补跑一遍。缺省则不做该去重。
 */
export function useDailyAutoCheck(
  scope: string,
  projectPath: string,
  onScheduledRun: () => void,
  taskKind?: TaskKind,
) {
  const [lastAutoAt, setLastAutoAt] = useState<string | null>(null);
  const onScheduledRef = useRef(onScheduledRun);
  onScheduledRef.current = onScheduledRun;

  const tasks = useTasks();
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const activeCount = countActiveTasks(tasks);

  /** 待执行的日期键（null = 不排队） */
  const [pending, setPending] = useState<string | null>(null);
  /** 等待截止时刻（绝对时间：反复重排定时器也不会把上限不断推后） */
  const deadlineRef = useRef(0);

  // ① 进页面：今天还没跑过 → 登记待跑。此处只登记，不写今日记录。
  useEffect(() => {
    if (!projectPath) return;
    const today = needsDailyRun(readStoredAuto(scope, projectPath));
    if (!today) return;
    if (taskKind && ranToday(tasksRef.current, taskKind, projectPath)) return;
    deadlineRef.current = Date.now() + AUTO_DEFER_MAX_MS;
    setPending(today);
  }, [scope, projectPath, taskKind]);

  // ② 有空闲槽位才真跑；槽位一直忙则等到上限后放弃（不写今日记录）
  useEffect(() => {
    if (!pending) return;
    // 等待期间用户已经手动跑过 → 不补跑（否则会把刚看过的结果再扫一遍）
    if (taskKind && ranToday(tasksRef.current, taskKind, projectPath)) {
      setPending(null);
      return;
    }
    if (shouldDeferAutoRun(activeCount)) {
      const remaining = deadlineRef.current - Date.now();
      if (remaining <= 0) {
        setPending(null);
        return;
      }
      const timer = setTimeout(setPending, remaining, null);
      return () => clearTimeout(timer);
    }
    writeStoredAuto(scope, projectPath, pending);
    setPending(null);
    setLastAutoAt(new Date().toLocaleString());
    onScheduledRef.current();
  }, [pending, activeCount, scope, projectPath, taskKind]);

  return { lastAutoAt };
}
