/**
 * 诊断落盘用的时间锚点与快照时间合并。
 *
 * 从 `zh-diagnostics-persist.ts` 拆出：主文件已接近 400 行代码阈值，
 * 这两个纯函数与落盘流程无关，拆出后行为不变。
 */

/**
 * 本次扫描的时间锚点：**取报告自带时间，不取写盘时刻**。
 *
 * 一次 pipeline 结果会被多个入口同时消费（首页一键体检、报告中心、项目引导）：
 * 任务中心把并发请求合并成同一个 task，几个调用方 `await` 到的是**同一份** report，
 * 各自落盘时若都取 `new Date()`，两次写盘差几毫秒 —— 历史去重键
 * `scanId = sha16(domain|scannedAt|指纹hash)` 随之失效，同一次扫描被记成两条
 * （2026-10-30 实测 19:32:57.393 / 19:32:57.395，指纹与分数完全相同）；
 * 连带 `rescuePreviousScore` 也把「自己」当成上一轮，凭空多出一条对比基线。
 *
 * 报告的 timestamp 同一次扫描恒等 → 重复落盘自然落到 `duplicate`，
 * 且 `rescuePreviousScore` 的 `generatedAt !== report.generatedAt` 判据继续成立。
 * 跨进程（worker）传输时 Date 可能已退化成字符串，故两种形态都接住。
 */
export function scanTimeAnchor(timestamp: unknown): string {
  const parsed = timestamp instanceof Date ? timestamp : new Date(String(timestamp ?? ''));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** 两个快照时间里取较旧的一份；任一方不可解析时退回另一方（都缺省则由落盘方取当前时刻） */
export function olderSnapshotTime(prev: string | undefined, current: unknown): unknown {
  const currentText = current instanceof Date ? current.toISOString() : String(current ?? '');
  const prevTs = prev ? Date.parse(prev) : NaN;
  const currentTs = currentText ? Date.parse(currentText) : NaN;
  if (!Number.isFinite(prevTs)) return current;
  if (!Number.isFinite(currentTs)) return prev;
  return new Date(Math.min(prevTs, currentTs)).toISOString();
}
