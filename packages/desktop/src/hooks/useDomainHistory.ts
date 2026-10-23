/**
 * 某域的扫描历史（新 → 旧）。
 *
 * 与 `useSavedDomainReport` 的分工：
 * - `useSavedDomainReport` 拿「最近一次完整报告」用于渲染详情；
 * - 本 Hook 拿「每一次的摘要」用于回答「这次比上次涨了还是跌了」。
 *
 * 没有历史（升级前扫的、或该域从未扫过）→ 空数组，面板自行隐藏，不占位、不造数据。
 */

import { useEffect, useState } from 'react';
import { listDomainHistory } from '../services/engineApi';
import type { DomainScanRecordData } from '../types/electron';

/** 默认展示条数：够看近期趋势，又不至于把面板撑成一张长表 */
export const DOMAIN_HISTORY_LIMIT = 12;

export function useDomainHistory(
  projectPath: string,
  domain: string | undefined,
  limit = DOMAIN_HISTORY_LIMIT,
): { records: DomainScanRecordData[]; loading: boolean } {
  const [records, setRecords] = useState<DomainScanRecordData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!domain) {
      setRecords([]);
      return;
    }
    let alive = true;
    setLoading(true);
    void listDomainHistory(projectPath, domain, limit).then((list) => {
      if (!alive) return;
      setRecords(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [projectPath, domain, limit]);

  return { records, loading };
}
