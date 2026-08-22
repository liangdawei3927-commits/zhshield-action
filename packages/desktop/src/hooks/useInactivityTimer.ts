import { useEffect, useState, useCallback, useRef } from 'react';

/**
 * 监听用户活动（鼠标/键盘/滚动），超时返回 idle 状态
 * @param timeout 无操作超时时间（毫秒），默认 7 分钟
 */
export function useInactivityTimer(timeout = 7 * 60 * 1000): {
  idle: boolean;
  reset: () => void;
} {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const reset = useCallback(() => {
    setIdle(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIdle(true), timeout);
  }, [timeout]);

  useEffect(() => {
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];

    const handleActivity = () => {
      reset();
    };

    for (const event of events) {
      document.addEventListener(event, handleActivity, { passive: true });
    }

    // Start the timer
    reset();

    return () => {
      for (const event of events) {
        document.removeEventListener(event, handleActivity);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [reset]);

  return { idle, reset };
}
