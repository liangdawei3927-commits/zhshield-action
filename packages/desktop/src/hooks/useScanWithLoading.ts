import { useCallback } from 'react';

/**
 * 「置 loading → 运行扫描 → 回填报告 → 关 loading」骨架。
 *
 * 仅覆盖 secrets 一处**直连主进程**的 `handleScan`
 *（`setLoading(true); const result = await scan(path); setReport(result); setLoading(false);`，
 * 无 try/finally —— 与原实现一致，失败时会跳过 `setLoading(false)`）。
 *
 * 与 `useRunWithReport` 的区别：后者处理「失败清空 report」的 try/catch，
 * 且不管理 loading；此处不做任何额外错误处理，保持行为不变。
 */
export function useScanWithLoading<T>(
  projectPath: string,
  scan: (path: string) => Promise<T | null>,
  setReport: (value: T | null) => void,
  setLoading: (value: boolean) => void,
): { handleScan: () => Promise<void> } {
  const handleScan = useCallback(async () => {
    setLoading(true);
    const result = await scan(projectPath);
    setReport(result);
    setLoading(false);
  }, [projectPath, scan, setReport, setLoading]);

  return { handleScan };
}
