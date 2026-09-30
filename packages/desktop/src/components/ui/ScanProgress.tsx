interface ScanProgressProps {
  /** 进度百分比 0-100 */
  progress: number;
  /** 进度提示文字（为空时不渲染 label 行） */
  label?: string;
}

/**
 * 扫描/检查进度条：label 行（小号灰色文字 + 右侧百分比加粗）+ 底部圆角进度条。
 * 宽度与 PrimaryButton（220px）对齐，用于页面主按钮上方的进度展示。
 */
export function ScanProgress({ progress, label }: ScanProgressProps) {
  const clamped = Math.min(Math.max(progress, 0), 100);
  return (
    <div className="w-[220px] flex flex-col items-center gap-1.5">
      {label ? (
        <div className="w-full flex items-center justify-between gap-3">
          <span className="text-xs text-zh-muted truncate">{label}</span>
          <span className="text-xs font-semibold text-zh-ink-2 tabular-nums shrink-0">
            {Math.round(clamped)}%
          </span>
        </div>
      ) : null}
      <div className="w-full h-1.5 rounded-full bg-zh-line overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-800 transition-[width] duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}