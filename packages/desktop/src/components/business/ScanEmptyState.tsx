import type { ReactNode } from 'react';

export interface ScanEmptyStateParams {
  projectPath: string;
  loading: boolean;
  /** 扫描进度百分比 0-100（由 0-1 的原始进度四舍五入而来） */
  progress: number;
  statusMessage?: string;
  onScan: () => void;
}

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
