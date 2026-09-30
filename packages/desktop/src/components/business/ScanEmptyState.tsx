import type { ReactNode } from 'react';

/**
 * 扫描型副页的「尚未出报告」分支（安全扫描 / 垃圾清理共用）
 *
 * 两页的页面结构在「有报告」时各自不同，但收尾的「无报告 → 渲染空态页」分支
 * 此前逐字相同（同 5 个参数 + setShowHome(false) + handleScan 组合）。此处收敛为
 * 共享分支：统一把 0-1 进度换算为 0-100 百分比，再由 `render` 注入各页专属空态组件。
 */
export interface ScanEmptyStateParams {
  projectPath: string;
  loading: boolean;
  /** 扫描进度百分比 0-100（由 0-1 的原始进度四舍五入而来） */
  progress: number;
  statusMessage?: string;
  onScan: () => void;
}

/** 无报告分支：把通用扫描参数交给各页专属空态组件渲染（不额外包裹 DOM 节点） */
export function ScanEmptyStateBranch({
  projectPath,
  loading,
  progress,
  statusMessage,
  onScan,
  render,
}: ScanEmptyStateParams & { render: (params: ScanEmptyStateParams) => ReactNode }) {
  return (
    <>{render({ projectPath, loading, progress: Math.round(progress * 100), statusMessage, onScan })}</>
  );
}
