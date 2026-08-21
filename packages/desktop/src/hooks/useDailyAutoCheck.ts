import { useEffect, useRef, useState } from 'react';

/** 每天 0 点后自动触发一次回调（固定行为，无需用户配置）：每分钟检测，跨过 0 点后触发一次 */
export function useDailyAutoCheck(projectPath: string, onScheduledRun: () => void) {
  const [lastAutoAt, setLastAutoAt] = useState<string | null>(null);
  const onScheduledRef = useRef(onScheduledRun);
  onScheduledRef.current = onScheduledRun;
  const lastRunDayRef = useRef(-1);
  useEffect(() => {
    if (!projectPath) return;
    const timer = setInterval(() => {
      const now = new Date();
      const day = now.getDate();
      if (now.getHours() === 0 && lastRunDayRef.current !== day) {
        lastRunDayRef.current = day;
        setLastAutoAt(now.toLocaleString());
        onScheduledRef.current();
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [projectPath]);
  return { lastAutoAt };
}
