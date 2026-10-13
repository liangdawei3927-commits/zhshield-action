import { useCallback } from 'react';

/**
 * 通用「运行扫描并回填报告」骨架：
 * 成功 → `setReport(result)`；失败 → `setReport(null)`。
 *
 * 仅覆盖 performance / security 两处逐字一致的 `handleScan`。
 * 其余页面语义不同故不纳入：dependency 额外管理 loading（try/finally），
 * secrets / tech-debt 无 catch（失败不回填 null）。
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
    } catch {
      setReport(null);
    }
  }, [projectPath, run, setReport]);

  return { handleScan };
}
