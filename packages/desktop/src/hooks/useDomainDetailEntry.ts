/**
 * 域详情入口：详情不可用时改看「上次落盘快照」的那条通道。
 *
 * 六个域页面（依赖 / 垃圾 / 性能 / 重构 / 安全 / 技术债）此前各自复制了一份
 * 快照视图状态 + `openDetail` 逻辑 + 快照视图的 prop 装配，改一处只能覆盖一个页面。
 * 收敛到这里之后，「点详情绝不替用户重新扫描」这条口径只有一份实现。
 *
 * 判定顺序（与页面原有行为一致，不要改成别的顺序）：
 * 1. 有完整报告 → 直接进详情；
 * 2. 没有 → 读上次落盘快照（只读，不发起检查）；
 * 3. 要新结果，由详情页里的「重新检查」按钮自己触发。
 */

import { useCallback, useEffect, useState } from 'react';
import { useDomainSnapshot, type DomainSnapshotState } from './useDomainSnapshot';
import { useSavedDomainReport } from './useSavedDomainReport';
import { useHasDomainResult } from './useHasDomainResult';
import type { SnapshotReport } from '../pages/domain-snapshot-logic';

/**
 * 快照视图的公共 props（各页面只差 `dimension` 与 `icon`）。
 *
 * 抽成对象是为了让六个页面直接 `{...snapshotViewProps}` 展开 —— 否则这五行的
 * prop 装配会在每个页面各留一份复制品。
 */
export interface DomainSnapshotViewProps {
  projectPath: string;
  snapshot: SnapshotReport | null;
  loading: boolean;
  rescanning: boolean;
  onRescan: () => void;
  onBackHome: () => void;
}

/** 详情入口的对外状态：快照视图可见性 + 打开动作 */
export interface DomainDetailEntry {
  /** 上次落盘快照（仅在没有完整报告时展示） */
  snapshot: DomainSnapshotState;
  /** 是否正在展示快照视图 */
  showSnapshot: boolean;
  /** 退出快照视图（返回主页 / 进入详情时调用） */
  setShowSnapshot: (next: boolean) => void;
  /** 详情入口点击：有报告进详情，无报告看快照 */
  openDetail: () => void;
  /** 直接展开给 DomainSnapshotReport，页面只需再补 dimension 与 icon */
  snapshotViewProps: DomainSnapshotViewProps;
}

export function useDomainDetailEntry<T>(params: {
  projectPath: string;
  /** 域键（与 IPC / 落盘目录一致，如 deps / garbage / performance） */
  domain: string;
  /** 当前可用的完整报告；非 null 时 openDetail 直接进详情 */
  detailReport: T | null;
  /** 切到详情视图（页面自己控制 showHome 之类的视图状态） */
  onEnterDetail: () => void;
  /** 该域是否正在扫描（快照视图里「重新检查」按钮据此置灰） */
  rescanning: boolean;
  /** 重新检查（仍由页面自己的扫描入口执行，本 hook 不发起扫描） */
  onRescan: () => void;
}): DomainDetailEntry {
  const { projectPath, domain, detailReport, onEnterDetail, rescanning, onRescan } = params;
  const snapshot = useDomainSnapshot(projectPath, domain);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const { reload } = snapshot;

  const openDetail = useCallback(() => {
    if (detailReport) {
      onEnterDetail();
      return;
    }
    reload();
    setShowSnapshot(true);
  }, [detailReport, onEnterDetail, reload]);

  const backHome = useCallback(() => setShowSnapshot(false), []);

  return {
    snapshot,
    showSnapshot,
    setShowSnapshot,
    openDetail,
    snapshotViewProps: {
      projectPath,
      snapshot: snapshot.snapshot,
      loading: snapshot.loading,
      rescanning,
      onRescan,
      onBackHome: backHome,
    },
  };
}

/** 分类页「详情入口」的完整状态：报告来源判定 + 主页/详情视图切换 + 快照通道 */
export interface DomainDetailPageState<T> extends DomainDetailEntry {
  /** 实时结果优先；扫描进行中不拿旧报告顶替（保持「扫描中看进度」） */
  detailReport: T | null;
  /** 详情入口是否可见：有报告（实时或落盘）或该域跑过（磁盘有分） */
  hasDetail: boolean;
  /** 是否停留在分类主页（false = 已进入详情视图） */
  showHome: boolean;
  /** 返回分类主页 */
  backHome: () => void;
  /** 主页「开始扫描」：先切到详情视图再扫描，扫完直接看报告 */
  startScan: () => void;
}

/**
 * 分类页详情入口的一站式状态（依赖 / 垃圾 / 性能 / 技术债四个页面共用）。
 *
 * 为什么要有这一层：上面三件事（读回落盘报告、判「该域跑过没有」、装配详情入口）
 * 在四个页面里是逐字相同的 19 行样板，任何口径调整都要改四处且容易漏改。
 * 收敛后每个页面只剩一次调用，且「打开先落在主页」「点详情不发起检查」
 * 「扫出结果自动进详情」三条行为只有一份实现。
 *
 * 参数用位置式而非对象：对象字面量会让四个页面的调用点本身又变成一段
 * 50+ token 的相同代码，重复检测照样报——那就等于没收敛。
 */
export function useDomainDetailPage<T>(
  projectPath: string,
  domain: string,
  liveReport: T | null,
  loading: boolean,
  onScan: () => void,
): DomainDetailPageState<T> {
  // 打开先落在主页：历史报告只让「详情按钮」可见，不自动把人带进详情
  const [showHome, setShowHome] = useState(true);

  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。这里读回该域完整报告
  const savedReport = useSavedDomainReport<T>(projectPath, domain, liveReport);
  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, domain);

  // 单一判定源：实时结果优先；扫描进行中不拿旧报告顶替
  const detailReport = liveReport ?? (loading ? null : savedReport);
  const hasDetail = detailReport !== null || hadPreviousResult;

  const entry = useDomainDetailEntry<T>({
    projectPath,
    domain,
    detailReport,
    onEnterDetail: () => setShowHome(false),
    rescanning: loading,
    onRescan: onScan,
  });
  const { setShowSnapshot } = entry;

  // 实时扫描出结果时进入详情 —— 复刻原有「扫完直接看报告」的行为
  useEffect(() => {
    if (liveReport) {
      setShowHome(false);
      setShowSnapshot(false);
    }
  }, [liveReport, setShowSnapshot]);

  const backHome = useCallback(() => setShowHome(true), []);
  const startScan = useCallback(() => {
    setShowHome(false);
    onScan();
  }, [onScan]);

  return { ...entry, detailReport, hasDetail, showHome, backHome, startScan };
}
