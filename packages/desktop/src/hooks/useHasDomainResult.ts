/**
 * 该域是否跑过（有落盘结果）—— 「详情入口」是否可见的判据。
 *
 * 为什么单独立一个 hook：分类页里「评分」读的是磁盘（`getDomainScore`），
 * 而「详情」原先只认内存 report，两套数据源导致「有分没按钮」。
 * 这里与评分同源（都问磁盘有没有结果），于是：
 * 跑过的域（有分）→ 按钮出现；没跑过（没分）→ 不出现。
 *
 * 注意：本 hook 只回答「有没有跑过」，不回答「内容是什么」。
 * 内容由 `useSavedDomainReport`（完整报告）/ 快照映射负责 ——
 * 页面在「有结果但无完整报告」时会先跑一次真实扫描再进详情，绝不拼假数据。
 */

import { useEffect, useState } from 'react';
import { hasDomainResult } from '../services/engineApi';

export function useHasDomainResult(projectPath: string, domain: string): boolean {
  const [hasResult, setHasResult] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHasResult(false);
    void hasDomainResult(projectPath, domain).then((value) => {
      if (!cancelled) setHasResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, domain]);

  return hasResult;
}
