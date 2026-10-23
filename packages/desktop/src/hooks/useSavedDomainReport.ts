/**
 * 分类页「上次扫描结果」读回 + 本次结果落盘。
 *
 * 解决什么：页面 `report` 只活在内存里，退出即丢；而评分是读磁盘的，
 * 于是出现「有评分、却没有详情按钮」（按钮判定的是内存 report）。
 *
 * 做法：把每个域**完整报告**按域落一份盘（`<project>/.zhshield/reports/<domain>.json`），
 * 打开页面时读回。读回的是同一份数据、同一套字段，不做任何再造 ——
 * 详情页结构与数字口径都不变，不需要为「只有问题项」做展示层妥协。
 *
 * 用法：
 * ```tsx
 * const saved = useSavedDomainReport(projectPath, 'deps', report);
 * const detailReport = report ?? (loading ? null : saved);
 * ```
 * 实时结果永远优先；扫描进行中不拿旧报告顶替，保持「扫描中看进度」的原行为。
 */

import { useEffect, useState } from 'react';
import { getSavedDomainReport, saveDomainReport } from '../services/engineApi';

export function useSavedDomainReport<T>(
  projectPath: string,
  domain: string,
  liveReport: T | null,
): T | null {
  const [saved, setSaved] = useState<T | null>(null);

  // 挂载 / 切换项目：读回该域最近一次完整报告
  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    void getSavedDomainReport<T>(projectPath, domain).then((value) => {
      if (!cancelled) setSaved(value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, domain]);

  // 本次扫描产出结果：立即落盘，供下次打开回看
  useEffect(() => {
    if (!liveReport) return;
    setSaved(liveReport);
    void saveDomainReport(projectPath, domain, liveReport);
  }, [projectPath, domain, liveReport]);

  return saved;
}
