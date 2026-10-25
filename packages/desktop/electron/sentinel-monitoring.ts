/**
 * 哨兵监控表（纯逻辑，零 Electron 依赖 —— 便于直接单测）
 *
 * 三个监视器（文件 / 日志 / 进程）在 @zh/sentinel 里都是**进程内单例**：
 * `start()` 按项目累加订阅，`stop()` 却只能整体停。所以「暂停某个项目」在主进程
 * 侧的正确动作是「把它从监控表里移除」，再由调用方决定：
 *
 * - 剩余为空 ⇒ 真的 `stopAllMonitoring()`；
 * - 还有剩余 ⇒ 停掉全部后按剩余项重新 start（单例模型的代价，见 ipc/sentinel.ts）。
 *
 * 单独成文件的原因与 `services/cancel-error.ts` 同源：接线是否成立要能被单测断言，
 * 而不是只能在跑起来的 Electron 里观察。
 */

/** 监控表条目：项目 id → 项目路径 */
export type MonitoringTable = Map<string, string>;

export interface MonitoringStopResult {
  /** 该项目此前确实在监控中（false = 用户点了停止但该压根没在监控，不该显示"已停止"） */
  stopped: boolean;
  /** 停止后仍在监控中的项目（调用方据此重启或全停） */
  remaining: Array<[string, string]>;
}

/**
 * 从监控表移除一个项目（原地修改）。
 *
 * 刻意不做"没找到就抛错"：UI 上的停止按钮在状态不同步时可能被点到（主进程重启后
 * 内存表清空、页面还显示监控中），此时如实返回 stopped=false 比抛错更接近事实。
 */
export function applyMonitoringStop(
  monitored: MonitoringTable,
  projectId: string,
): MonitoringStopResult {
  const stopped = monitored.delete(projectId);
  return { stopped, remaining: [...monitored.entries()] };
}
