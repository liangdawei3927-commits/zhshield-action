import { useCallback } from 'react';

/**
 * 用 loading 开关包裹一次异步动作：执行前 setLoading(true)，结束（成功或抛错）后 setLoading(false)。
 *
 * 供「刷新 / 启动监控」等只需展示 loading、且以 finally 保证收尾的场景复用，
 * 避免各处重复 try/finally 骨架。action 与 setLoading 均需稳定引用
 * （模块级函数 / useState setter）以保持 useCallback 记忆化语义。
 */
export function useLoadingAction(
  action: () => Promise<void>,
  setLoading: (v: boolean) => void,
): () => Promise<void> {
  return useCallback(async () => {
    setLoading(true);
    try {
      await action();
    } finally {
      setLoading(false);
    }
  }, [action, setLoading]);
}
