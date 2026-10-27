/**
 * 扫描结束后的自动进入详情页 —— 唯一的判定与执行点（8 个分类页共用）。
 *
 * 行为契约（与 `scan-entry-logic` 的纯函数一一对应）：
 * 1. 只在「上一次在跑、这一次停了、且产出了新报告」时判定；
 * 2. 判定要读该域的实时评分（与分类页顶部评分环同一个 IPC、同一份快照），
 *    **满分 100 → 留在主页**；不满分或判断不了 → 进详情；
 * 3. 判定完成时把 `scanVersion` 加一，页面拿它当主页的 `key`，
 *    强制主页重新挂载 —— 否则停在主页时评分环仍是扫描前读到的旧分
 *    （`useDomainScoreView` 只在挂载/换 key 时读盘），用户会看到
 *    「刚扫完 100 分，环上还是上次的 43 分」。
 *
 * 为什么评分要另开一次 IPC 而不是拿报告自己算：页面若自算分数就成了第三套口径，
 * 必然与报告中心/评分环对不上（项目里已经踩过这个坑）。这里只读不算。
 */

import { useEffect, useRef, useState } from 'react';
import { getDomainScore } from '../services/engineApi';
import { navScoreDimension } from '../components/layout/nav-items';
import { useLatestRef } from './useLatestRef';
import { scanTransition, shouldAutoEnterDetail, type ScanWatch } from './scan-entry-logic';

/** useScanResultEntry 的入参：项目路径、域键、实时报告与进入详情回调 */
export interface ScanResultEntryParams {
  /** 项目绝对路径 */
  projectPath: string;
  /** 本页的导航 id（= 域键，决定读哪一维的分） */
  navId: string;
  /** 本域实时报告：扫描完成后是新对象；挂载时的回读报告不算「本次结果」 */
  liveReport: unknown;
  /** 本域是否正在扫描（含排队） */
  loading: boolean;
  /** 进入详情（页面自己切 showHome） */
  onEnterDetail: () => void;
}

/** useScanResultEntry 的返回值：主页重挂载版本号 */
export interface ScanResultEntry {
  /**
   * 主页重挂载版本号：每次「扫描产出新结果」加一。
   * 页面把它当主页分支的 `key`，让评分环 / 详情入口 / 快照一起重新读盘。
   */
  scanVersion: number;
}

export function useScanResultEntry({
  projectPath,
  navId,
  liveReport,
  loading,
  onEnterDetail,
}: ScanResultEntryParams): ScanResultEntry {
  // onEnterDetail 在页面里多为内联箭头函数：用 ref 持有，effect 只依赖数据
  const onEnterRef = useLatestRef(onEnterDetail);
  // 上一刻的扫描状态。初值取首次渲染的真实值 → 页面刚打开时不会被误判成「刚跑完」
  const prevRef = useRef<ScanWatch>({ loading, report: liveReport });
  const [scanVersion, setScanVersion] = useState(0);

  useEffect(() => {
    const prev = prevRef.current;
    const next: ScanWatch = { loading, report: liveReport };
    prevRef.current = next;
    if (scanTransition(prev, next) !== 'finished') return;

    // 新结果落地：主页数据全部作废（分数、详情入口可见性都读磁盘）
    setScanVersion((version) => version + 1);

    let alive = true;
    const dimension = navScoreDimension(navId);
    void (async () => {
      // 没有对应维度 = 判断不了 → shouldAutoEnterDetail(null) 走「展示结果」档
      const signal = dimension ? await getDomainScore(projectPath, dimension) : null;
      if (!alive) return;
      if (shouldAutoEnterDetail(signal)) onEnterRef.current();
    })();

    return () => {
      alive = false;
    };
  }, [loading, liveReport, projectPath, navId]);

  return { scanVersion };
}
