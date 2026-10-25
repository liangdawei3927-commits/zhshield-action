import { useCallback } from 'react';
import { isCancelledError } from '../services/cancel-error';

/**
 * 通用「运行扫描并回填报告」骨架：
 * 成功 → `setReport(result)`；失败 → `setReport(null)`。
 *
 * 用户点「停止」也会走到 catch（取消经 IPC reject 返回），那不是失败：
 * 保留已有报告而不是清空，否则用户停掉一次重扫，屏幕上刚看的报告会一起消失。
 *
 * 覆盖 performance / security / dependency / tech-debt 四处逐字一致的 `handleScan`。
 * 其余页面语义不同故不纳入（例如 secrets 无 catch，失败不回填 null）。
 */
export function useRunWithReport<T>(
  projectPath: string,
  run: (path: string) => Promise<T>,
  setReport: (value: T | null) => void,
): { handleScan: () => Promise<void> } {
  const handleScan = useCallback(async () => {
    try {
      const result = await run(projectPath);
      setReport(result);
    } catch (err: unknown) {
      if (isCancelledError(err)) return;
      setReport(null);
    }
  }, [projectPath, run, setReport]);

  return { handleScan };
}
