import type { ReactNode } from 'react';

export interface ScanEmptyStateParams {
  projectPath: string;
  loading: boolean;
  /** 扫描进度 0..1（任务中心原始进度；百分比换算由 DomainScanProgress 收口） */
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
  return <>{render({ projectPath, loading, progress, statusMessage, onScan })}</>;
}
