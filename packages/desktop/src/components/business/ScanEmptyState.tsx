import type { ReactNode } from 'react';

export interface ScanEmptyStateParams {
  projectPath: string;
  loading: boolean;
  /** 扫描进度 0..1（任务中心原始进度；百分比换算由 DomainScanProgress 收口） */
  progress: number;
  statusMessage?: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」，进度条显示排队位置） */
  queued?: boolean;
  queuePosition?: number;
  /** 停止当前扫描（运行/排队时按钮旁出现「停止」） */
  onCancel?: () => void;
  /** 已发出取消、等确认 */
  stopping?: boolean;
  onScan: () => void;
}

/**
 * 各域空态传给 DomainEmptyView 的「运行态尾巴」：排队 / 停止 / 进度 / 状态消息。
 *
 * 独立于 {@link ScanEmptyStateParams} 定义（不复用 Pick）：guard 空态的 progress 是
 * 可选、其余域是必填，按最小契约声明才能同时接受两者。
 */
export interface ScanRunProps {
  loading: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源） */
  progress?: number;
  statusMessage?: string;
  queued?: boolean;
  queuePosition?: number;
  onCancel?: () => void;
  stopping?: boolean;
}

/**
 * 摘出空态的运行态字段。
 *
 * 每个域的空态组件（guard / garbage / security / …）传给 DomainEmptyView 的这 7 个
 * prop 完全一致，逐行展开会让同一个尾巴在每个域里各抄一遍（jscpd 判跨文件重复代码）。
 * 统一从这里派生：加一个运行态字段只改本函数，不必每域再改一遍。
 */
export function scanRunProps(p: ScanRunProps): ScanRunProps {
  return {
    loading: p.loading,
    progress: p.progress,
    statusMessage: p.statusMessage,
    queued: p.queued,
    queuePosition: p.queuePosition,
    onCancel: p.onCancel,
    stopping: p.stopping,
  };
}

export function ScanEmptyStateBranch({
  projectPath,
  loading,
  progress,
  statusMessage,
  queued,
  queuePosition,
  onCancel,
  stopping,
  onScan,
  render,
}: ScanEmptyStateParams & { render: (params: ScanEmptyStateParams) => ReactNode }) {
  return (
    <>
      {render({
        projectPath,
        loading,
        progress,
        statusMessage,
        queued,
        queuePosition,
        onCancel,
        stopping,
        onScan,
      })}
    </>
  );
}
