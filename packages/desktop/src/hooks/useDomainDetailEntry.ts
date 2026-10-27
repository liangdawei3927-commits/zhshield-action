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
import { useLatestRef } from './useLatestRef';
import { useScanResultEntry } from './useScanResultEntry';
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

/** 把「每次渲染都是新引用」的回调挂到 ref 上，供只依赖数据的 effect 使用 */

/**
 * 快照视图是否可见 —— **派生**而非直接下发。
 *
 * 直下发的失效形态（2026-10-25 实测，重构页最明显）：页面挂载后落盘报告是
 * 异步读回的，若用户在这几十~几百毫秒内点开详情，`openDetail` 看到的是
 * `detailReport === null`，于是标记「看快照」；报告随后读回来，这个标记仍是
 * true，页面就永久停在「最近一次检查结果」的平铺条目列表上，原本的分类 tab
 * 再也回不来（重构域报告 710KB，窗口足够大到必现）。
 *
 * 判据只有一个：**报告就绪就不该再渲染快照**。因此这里让报告状态直接压过标记，
 * 不依赖 effect 的渲染时序；下面那条 effect 负责把标记清干净。
 */
function isSnapshotVisible<T>(snapshotRequested: boolean, detailReport: T | null): boolean {
  return snapshotRequested && detailReport === null;
}

/** 意图兑现的入参（报告态 + 两个 setState + 持有最新回调的 ref） */
interface DomainIntentSettleParams<T> {
  /** 当前可用的完整报告；null = 报告未就绪，不动任何状态 */
  detailReport: T | null;
  /** 用户点过「详情」但当时没有报告 */
  detailIntent: boolean;
  /** 快照视图开关 */
  setSnapshot: (next: boolean) => void;
  /** 意图标记开关 */
  setIntent: (next: boolean) => void;
  /** 持有最新 onEnterDetail 的 ref（避免 effect 依赖内联箭头函数） */
  onEnterRef: { current: () => void };
}

/**
 * 报告读回来了就把「点过详情」的意图兑现掉。
 *
 * 少了这一步：快照被压掉后 `showHome` 仍是 true，页面会退回分类主页 ——
 * 用户明明点了详情，却被弹回列表，看起来像「分类又没了」。
 */
function useDetailIntentSettle<T>({
  detailReport,
  detailIntent,
  setSnapshot,
  setIntent,
  onEnterRef,
}: DomainIntentSettleParams<T>): void {
  useEffect(() => {
    if (detailReport === null) return;
    setSnapshot(false);
    if (detailIntent) {
      setIntent(false);
      onEnterRef.current();
    }
  }, [detailReport, detailIntent]);
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
  const [snapshotRequested, setSnapshotRequested] = useState(false);
  /** 用户点过「详情」但当时没有完整报告（正等落盘报告读回） */
  const [detailIntent, setDetailIntent] = useState(false);
  const { reload } = snapshot;

  // onEnterDetail 在页面里常是内联箭头函数，每次渲染都是新引用；
  // 用 ref 持有可让下面的 effect 只依赖数据、不因父组件重渲染而空转。
  const onEnterRef = useLatestRef(onEnterDetail);

  const showSnapshot = isSnapshotVisible(snapshotRequested, detailReport);
  const setShowSnapshot = useCallback((next: boolean) => setSnapshotRequested(next), []);

  useDetailIntentSettle({
    detailReport,
    detailIntent,
    setSnapshot: setShowSnapshot,
    setIntent: setDetailIntent,
    onEnterRef,
  });

  const openDetail = useCallback(() => {
    if (detailReport) {
      onEnterDetail();
      return;
    }
    setDetailIntent(true);
    reload();
    setShowSnapshot(true);
  }, [detailReport, onEnterDetail, reload, setShowSnapshot]);

  const backHome = useCallback(() => {
    setDetailIntent(false);
    setShowSnapshot(false);
  }, [setShowSnapshot]);

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
  /**
   * 主页「开始扫描」：**只跑检查，不换页**。
   *
   * 扫完停在哪由 `useScanResultEntry` 判：满分 100 留在主页，不满分才自动展开详情。
   * 曾经这里是「先切详情再扫」，等于无条件跳转 —— 满分时用户也被扔进详情页。
   */
  startScan: () => void;
  /** 主页重挂载版本号：每次扫描产出新结果加一，页面拿它当主页分支的 key */
  scanVersion: number;
}

/** 分类页详情入口的一站式入参（六个值同属「本页这一域的入口」语义） */
export interface DomainDetailPageParams<T> {
  /** 项目绝对路径 */
  projectPath: string;
  /** 域键（与 IPC / 落盘目录一致，如 deps / garbage / performance） */
  domain: string;
  /** 本域实时报告（内存来源，非落盘）；未扫描或扫描中为 null */
  liveReport: T | null;
  /** 本域是否正在扫描（快照视图「重新检查」按钮据此置灰） */
  loading: boolean;
  /** 本页扫描入口（「开始扫描」与「重新检查」共用同一个） */
  onScan: () => void;
  /** 本页在导航里的 id（用于「从扫描进度条点进来直达详情」）；缺省与域键同名 */
  navId?: string;
}

/**
 * 分类页详情入口的一站式状态（依赖 / 垃圾 / 性能 / 技术债四个页面共用）。
 *
 * 为什么要有这一层：上面三件事（读回落盘报告、判「该域跑过没有」、装配详情入口）
 * 在四个页面里是逐字相同的 19 行样板，任何口径调整都要改四处且容易漏改。
 * 收敛后每个页面只剩一次调用，且「打开先落在主页」「点详情不发起检查」
 * 「扫完只有不满分才自动进详情」三条行为只有一份实现。
 *
 * 入参用对象而非位置式：函数原先刻意用位置式以让四个页面的调用点保持一行
 * （避免「调用点本身又变成一段相同代码」）。改成对象后调用点会摊成多行，代价是
 * 四份形状相近的字面量 —— 换来的是每个值在调用点自带字段名（`liveReport: report`
 * 比第 3 个位置参数更难传错），以及后续加参数不必回头改四个页面。
 * 这是权衡后的取舍，不是纯粹的净收益：若日后重复检测因这四处字面量报警，
 * 正确做法是把「页面接线」再收敛一层，而不是退回位置式。
 */
export function useDomainDetailPage<T>({
  projectPath,
  domain,
  liveReport,
  loading,
  onScan,
  navId = domain,
}: DomainDetailPageParams<T>): DomainDetailPageState<T> {
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

  // 扫完要不要进详情：只在「本次扫描产出新结果」时判，且满分不进（唯一口径，纯函数）
  const { scanVersion } = useScanResultEntry({
    projectPath,
    navId,
    liveReport,
    loading,
    onEnterDetail: () => setShowHome(false),
  });

  const backHome = useCallback(() => setShowHome(true), []);
  // 只跑检查、不换页：扫完停主页还是进详情由 useScanResultEntry 按分数决定
  const startScan = useCallback(() => onScan(), [onScan]);

  return { ...entry, detailReport, hasDetail, showHome, backHome, startScan, scanVersion };
}
