/**
 * 跨页「直达详情」意图 —— 一次性、带页归属的交接条。
 *
 * 为什么需要：分类页统一「打开先落在主页」（历史结果只让详情入口可见）。
 * 但有一类入口语义不是「我要逛这个分类」，而是「我要看这条正在跑/刚跑完的结果」
 * —— 右下角全局扫描进度条。它跳到归属页时若只做普通导航，用户会落在主页，
 * 还得再点一次右上角详情图标，等于把「看结果」这个动作拆成两步。
 *
 * 为何不做成 React 状态：导航有三条独立调用边（顶部导航、侧边栏、全局进度条），
 * 只有进度条需要携带意图；把意图塞进 NavigationContext 会让所有导航方都被迫表态，
 * 而 App 壳层还要多一层 state 透传。这里用一个只有本模块能读写的单例，
 * 语义收敛在「谁请求、哪个页取走」两件事上。
 *
 * 三个约束（缺一条就会退化成「莫名跳详情」）：
 * 1. **按页归属**：意图带目标页 id，别的页取不走 —— 否则用户点了进度条又改点
 *    侧边栏，会把无关页面推进详情；
 * 2. **取走即清**：目标页取过就删，页面重挂载（切项目、重渲染）不会二次跳转；
 * 3. **限时**：超过 TTL 视为过期。导航被拦（例如正在引导流程里）时意图会滞留，
 *    没有这条，几分钟后用户正常点进该分类会突然被带进详情。
 */

/** 意图只在这段时间内有效（毫秒）—— 人点完到页面挂载通常是几十毫秒 */
export const DETAIL_INTENT_TTL_MS = 2000;

export interface DetailIntent {
  /** 目标页 id（与 nav-items 的 NavItem.id 一致） */
  page: string;
  /** 请求时刻（ms） */
  at: number;
}

/** 纯判定：这条意图该不该被 `page` 取走（导出的目的是可单测，不读模块状态） */
export function shouldTakeIntent(
  intent: DetailIntent | null,
  page: string,
  now: number,
  ttl: number = DETAIL_INTENT_TTL_MS,
): boolean {
  if (!intent) return false;
  if (intent.page !== page) return false;
  const age = now - intent.at;
  // 负数 = 时钟回拨，按过期处理（宁可落主页，也不要误跳详情）
  return age >= 0 && age <= ttl;
}

let pending: DetailIntent | null = null;

/** 请求「进入 page 时直接展开详情」。后一次请求覆盖前一次 —— 意图永远只服务最近的点击 */
export function requestDetailIntent(page: string, now: number = Date.now()): void {
  pending = { page, at: now };
}

/** 取走意图：命中返回 true 并清除。页面在挂载 effect 里调用一次 */
export function takeDetailIntent(page: string, now: number = Date.now()): boolean {
  if (!shouldTakeIntent(pending, page, now)) {
    // 过期项顺手清掉，避免一直挂着等下一次误命中
    if (pending && now - pending.at > DETAIL_INTENT_TTL_MS) pending = null;
    return false;
  }
  pending = null;
  return true;
}

/** 当前待处理意图（只读快照，供测试与调试；业务代码不要据它做判断） */
export function peekDetailIntent(): DetailIntent | null {
  return pending;
}

/** 清空（测试用） */
export function resetDetailIntent(): void {
  pending = null;
}
