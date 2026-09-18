/**
 * 「每日自动检查」的纯判定逻辑（体检页 / 代码重构页共用）。
 *
 * 历史教训（09-19）：旧实现是在页面组件内挂 setInterval 每分钟探测 0 点，
 * 而 App 是条件渲染（同一时刻只挂载一个页面），定时器仅在页面挂载期间存在 ——
 * 「每日 0 点后自动巡检」是夸大承诺，真实触发条件是"用户恰好在 00:00–00:59
 * 打开本页"。现改为**每天首次进入本页时自动跑一次**，并把判定抽成纯函数可测。
 *
 * 记录持久化在 localStorage（key 含页面标识与 projectPath），用户离开页面
 * 中途返回同日不会重复触发；清浏览器数据后最多多跑一次，无副作用。
 */

/** 存储键：按页面（scope）与项目路径隔离，体检与重构互不干扰 */
export function dailyAutoKey(scope: string, projectPath: string): string {
  return `zhshield:daily-auto:${scope}:${projectPath}`;
}

/** 本地时区日期键（非 UTC —— 避免 0 点附近"差一整天"的误判） */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 判定今天是否需要自动跑：需要则返回今天的日期键（供调用方写入记录），
 * 已跑过则返回 null。
 * @param stored localStorage 里的上次记录（null = 无记录）
 * @param now 当前时间（可注入以便测试）
 */
export function needsDailyRun(stored: string | null, now: Date = new Date()): string | null {
  const today = localDayKey(now);
  return stored === today ? null : today;
}
