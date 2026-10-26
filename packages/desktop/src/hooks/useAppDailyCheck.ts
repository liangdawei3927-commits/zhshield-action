import { useCallback } from 'react';
import { runPipeline } from '../services/engineApi';
import { useDailyAutoCheck } from './useDailyAutoCheck';

/**
 * App 级「每日巡检」：打开客户端或切到某个项目时，当日首次系统空闲即补跑一次
 * 项目体检流水线（pipeline）——无需用户恰好路过体检页。
 *
 * 为什么挂在 App 级（2026-10-26 用户拍板）：页面级的触发条件是「每天第一次进入
 * 体检页」，用户打开客户端直奔哨兵页/分类页时，体检数据旧了也没人知道。升级为
 * 「打开客户端就算数」才贴近用户对「每日自动巡检」的预期。0 点定时器被刻意否决：
 * 桌面应用凌晨多半没开，定时器形同虚设（见 daily-auto-check-logic.ts 头注释）。
 *
 * 「首次添加项目自动首扫」由此免费获得：添加流程会把新项目切为当前项目，
 * projectPath 变化让 useDailyAutoCheck 重新登记 → 新项目无今日记录 → 空闲即跑。
 *
 * 与页面级（scope='inspect'）的去重联动：ranToday('pipeline', path) 两边共用——
 * 本会话里不管谁先跑过 pipeline，另一方都不会再补跑；localStorage 记录按 scope
 * 隔离，跨会话只认「今天跑没跑过」。
 *
 * ⚠️ 继承 useDailyAutoCheck 的让路语义：有活动任务就延后，等到上限放弃且不写
 * 今日记录（下次打开/切换再试）。失败不在 App 级弹错（任务中心可见失败状态，
 * fire-and-forget）；体检页的失败视图仍由页面级发起的运行负责。
 */
export function useAppDailyCheck(projectPath: string): void {
  const run = useCallback(() => {
    if (!projectPath) return;
    void runPipeline(projectPath, { sop: true, origin: 'auto' }).catch(() => undefined);
  }, [projectPath]);
  useDailyAutoCheck('app', projectPath, run, 'pipeline');
}
