interface ScanProgressProps {
  /** 进度百分比 0-100 */
  progress: number;
  /** 任务消息（task.message）。不再以可见文字渲染，降级为整条的悬停提示 */
  label?: string;
  /** 不确定态：任务在跑但暂无百分比，亮块在轨道内扫动（不显示百分比数字） */
  indeterminate?: boolean;
}

/**
 * 扫描/检查进度条 —— 全站唯一实现，只有「一种」视觉：
 * 轨道（固定长度）+ 填充段（宽度 = 真实进度）+ 填充段内部向右流动的光带 + 右侧百分比。
 *
 * 为什么不是「整条循环扫动 + 百分比」（2026-10-25 合并两种样式时的取舍）：
 * 整条循环扫动在 UI 语言里是 indeterminate 的专用符号（时长未知）。它与百分比并列时，
 * 条的位置与数字彻底脱钩 —— 数字从 10% 涨到 90%，条只是反复弹回左边。
 * 更糟的是本套扫描的 progress 是阶段边界汇报（常见 15% 长停再跳 60%），
 * 此时「条疯滚 + 数字不动」会被读作「卡住了还在转圈」，比静态条更焦虑。
 * 所以动态保留在填充段内部：条在变长（前进）、光在流（活着）、数字在涨（精确），
 * 三个信号同向，没有任何一处自相矛盾。
 *
 * 轨道高度 h-2（8px）而非原来的 h-1.5（6px）：6px 高的条里 40% 宽的白色光带
 * 几乎看不出在动，动效等于白做。
 *
 * 任务消息不进可见行（那是全站最挤的 220px 宽），改为容器 title ——
 * 长任务里「卡在哪个文件、哪个阶段」这条信息仍然可查，只是不再占版面。
 *
 * 宽度与 PrimaryButton（220px）对齐，用于页面主按钮上方的进度展示。
 */
export function ScanProgress({ progress, label, indeterminate = false }: ScanProgressProps) {
  const clamped = Math.min(Math.max(progress, 0), 100);
  const hint = label?.trim() || undefined;
  return (
    <div className="w-[220px] flex items-center gap-2" title={hint}>
      <div className="flex-1 h-2 rounded-full bg-zh-line overflow-hidden relative">
        {indeterminate ? (
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-brand-600 to-brand-800 animate-[zh-progress-indeterminate_1.2s_ease-in-out_infinite]" />
        ) : (
          <div
            className="relative h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-800 overflow-hidden transition-[width] duration-300"
            style={{ width: `${clamped}%` }}
          >
            <div className="absolute inset-y-0 left-0 w-2/5 bg-white/45 animate-[zh-progress-flow_1.4s_linear_infinite]" />
          </div>
        )}
      </div>
      <span className="shrink-0 w-9 text-right text-xs font-semibold text-zh-ink-2 tabular-nums">
        {indeterminate ? '—' : `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}
