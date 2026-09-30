/**
 * 智能引擎状态指示器（点位 + 文案）
 *
 * 引导页（onboarding 右上角）与屏保页（右上角）此前各内联一份逐字相同的
 * 绿/红点位与「智能引擎」文案；两处外层定位类与淡入延迟各不相同，
 * 故只把状态点位本身收敛到此处，DOM 输出与原实现一致。
 */
export function EngineStatusIndicator({ enabled }: { enabled: boolean }) {
  return (
    <>
      <span
        className="w-2 h-2 rounded-full"
        style={{
          background: enabled ? '#27c93f' : '#ef4444',
          boxShadow: `0 0 6px ${enabled ? '#27c93f' : '#ef4444'}`,
        }}
      />
      <span className="text-sm text-white/80">智能引擎</span>
    </>
  );
}
