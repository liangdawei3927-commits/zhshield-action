interface ScanProgressProps {
  /** 进度百分比 0-100 */
  progress: number;
  /** 进度提示文字（为空时不渲染 label 行） */
  label?: string;
  /** 不确定态：任务在跑但暂无百分比，亮块在轨道内扫动（不显示百分比数字） */
  indeterminate?: boolean;
}

/**
 * 扫描/检查进度条：label 行（小号灰色文字 + 右侧百分比加粗）+ 底部圆角进度条。
 * 宽度与 PrimaryButton（220px）对齐，用于页面主按钮上方的进度展示。
 */
export function ScanProgress({ progress, label, indeterminate = false }: ScanProgressProps) {
  const clamped = Math.min(Math.max(progress, 0), 100);
  return (
    <div className="w-[220px] flex flex-col items-center gap-1.5">
      {label || !indeterminate ? (
        <div className="w-full flex items-center justify-between gap-3">
          <span className="text-xs text-zh-muted truncate">{label}</span>
          {!indeterminate && (
            <span className="text-xs font-semibold text-zh-ink-2 tabular-nums shrink-0">
              {Math.round(clamped)}%
            </span>
          )}
        </div>
      ) : null}
      <div className="w-full h-1.5 rounded-full bg-zh-line overflow-hidden relative">
        {indeterminate ? (
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-brand-600 to-brand-800 animate-[zh-progress-indeterminate_1.2s_ease-in-out_infinite]" />
        ) : (
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-800 transition-[width] duration-300"
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
}
