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

/**
 * 后台自动检查最长等待时间：一直没等到空槽就放弃本次。
 *
 * 放弃时**不写今日记录** —— 下次进页面会再试。写记录等于宣称"今天查过了"，
 * 而实际没查；这类静默缺失比慢一次更糟。
 */
export const AUTO_DEFER_MAX_MS = 3 * 60 * 1000;

/**
 * 槽位忙就让路：只要有任务在 running/queued，后台自动检查不发起。
 *
 * 为什么是「有 1 个就让路」而不是「占满 2 个才让路」：主进程并发上限是 2
 * （electron/task-manager.ts 的 MAX_CONCURRENT）。若自动检查占了最后一个槽，
 * 用户此时点任何主操作按钮都只能排队；后台任务没有时效性，不该让用户的操作排在它后面。
 */
export function shouldDeferAutoRun(activeCount: number): boolean {
  return activeCount > 0;
}

/** 判定所需的最小任务形状（与 TaskInfo 结构兼容，便于测试传纯对象） */
export interface DailyTaskLike {
  kind: string;
  projectPath: string;
  /** ISO 时间串（TaskInfo.startedAt） */
  startedAt: string;
  status?: string;
}

/**
 * 今天是否已经跑过「同 kind 同项目」的任务（不看状态，含用户手动触发的那次）。
 *
 * 用途：自动检查在等空槽期间，用户可能已经手动点了按钮。等他跑完槽位变空，
 * 自动检查若照旧补跑，就会把刚看过的结果再扫一遍（结果闪变 + 白占一次槽）。
 *
 * cancelled 也算跑过：用户主动取消是明确意图，紧接着自动补跑属于骚扰。
 */
export function ranToday(
  tasks: readonly DailyTaskLike[],
  kind: string,
  projectPath: string,
  now: Date = new Date(),
): boolean {
  const today = localDayKey(now);
  return tasks.some(
    (task) =>
      task.kind === kind &&
      task.projectPath === projectPath &&
      localDayKey(new Date(task.startedAt)) === today,
  );
}
