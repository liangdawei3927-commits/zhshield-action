import { ScanProgress } from '../ui/ScanProgress';

export interface DomainScanProgressProps {
  /** 扫描是否在运行（任务中心 running/queued 态） */
  loading: boolean;
  /** 任务中心进度 0..1（与 TaskInfo.progress 同源；调用方禁止二次换算） */
  progress: number | undefined;
  /** 进度条上方状态消息（task.message） */
  label?: string;
  /** 外层容器类名（槽位排版） */
  className?: string;
}

/**
 * 统一扫描进度条（与 DomainScoreRing 同层的「领域连接件」）。
 *
 * 承担两件唯一真源的事：
 * 1) 单位换算 —— 任务中心的 progress 是 0..1，百分比是 0..100，换算只在此处发生；
 * 2) 显示门禁 —— 仅在 running 时出现；进度仍为 0 时退化为不确定态扫动条，
 *    消除「任务刚启动、条完全不渲染」的空白窗口。
 */
export function DomainScanProgress({
  loading,
  progress,
  label,
  className,
}: DomainScanProgressProps) {
  if (!loading || typeof progress !== 'number' || Number.isNaN(progress)) return null;
  const percent = Math.min(Math.max(Math.round(progress * 100), 0), 100);
  return (
    <div className={className}>
      <ScanProgress progress={percent} label={label} indeterminate={percent <= 0} />
    </div>
  );
}
