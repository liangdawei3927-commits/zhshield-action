/**
 * 读回「该域最近一次检查结果」（归一化快照）并整形为视图数据。
 *
 * 与 `useSavedDomainReport` 的分工：
 * - `useSavedDomainReport` 读**完整报告**（新版扫描后才落盘，链路完整）；
 * - 本 hook 读**评分赖以计算的那份快照**，用于「升级前扫过、没有完整报告」的旧数据。
 *
 * 两者都只读磁盘、都不发扫描：点详情永远是「看上次结果」，不会替用户重扫。
 */

import { useCallback, useEffect, useState } from 'react';
import { getDomainSnapshotRaw } from '../services/engineApi';
import { toSnapshotReport, type SnapshotReport } from '../pages/domain-snapshot-logic';

/** 域快照读取状态；snapshot 为 null 表示该域从未落盘过 */
export interface DomainSnapshotState {
  snapshot: SnapshotReport | null;
  /** 首次读取中（视图显示占位，不显示「无结果」以免误判） */
  loading: boolean;
  /** 重新读盘（点详情时调用，确保看到最新落盘内容） */
  reload: () => void;
}

export function useDomainSnapshot(projectPath: string, domain: string): DomainSnapshotState {
  const [snapshot, setSnapshot] = useState<SnapshotReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getDomainSnapshotRaw(projectPath, domain).then((raw) => {
      if (cancelled) return;
      setSnapshot(toSnapshotReport(raw));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, domain, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { snapshot, loading, reload };
}
