import { useEffect, useRef, useState } from 'react';
import { dailyAutoKey, needsDailyRun } from './daily-auto-check-logic';

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
 */
export function useDailyAutoCheck(scope: string, projectPath: string, onScheduledRun: () => void) {
  const [lastAutoAt, setLastAutoAt] = useState<string | null>(null);
  const onScheduledRef = useRef(onScheduledRun);
  onScheduledRef.current = onScheduledRun;

  useEffect(() => {
    if (!projectPath) return;
    const stored = readStoredAuto(scope, projectPath);
    const today = needsDailyRun(stored);
    if (!today) return;
    writeStoredAuto(scope, projectPath, today);
    setLastAutoAt(new Date().toLocaleString());
    onScheduledRef.current();
  }, [scope, projectPath]);

  return { lastAutoAt };
}
