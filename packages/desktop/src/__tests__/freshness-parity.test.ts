import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCORE_FRESH_MS, scoreFreshness } from '../pages/reports-logic';

/**
 * 新鲜度阈值「单一来源」锁
 *
 * 背景：结果距今超过 24h 即陈旧。这个阈值曾经是**两份实现** ——
 * 主进程 `DASHBOARD_FRESH_MS`（服务仪表盘六卡：`not-run | scored | expired`）与
 * 渲染进程 `SCORE_FRESH_MS`（服务报告中心的总分新鲜度标注）。两者各自独立写成
 * `24 * 60 * 60 * 1000`，中间没有任何机制保证一致；任一侧单独调整
 * （比如为了少打扰用户改成 48h）另一侧会**静默漂移** —— 一边说"已过期"、
 * 一边说"数据新鲜"，而两处代码看上去都对。这类分叉单测抓不到（要同时跑起
 * 主进程与渲染进程才能观察），所以当时用结构断言钉死了两者数值一致。
 *
 * 2026-09-19 起：六卡链路（`engine:getDashboardOverview`）因**渲染层零消费**被整体删除，
 * 主进程不再需要该阈值 → **阈值只剩渲染层一处**，漂移风险随之消失，parity 锁也随之
 * 失去了对象。本用例改为锁下面两件事：
 *   ① 唯一来源 `SCORE_FRESH_MS` = 24h，且**真被消费**（不是"声明了却没执行"的空壳常量）；
 *   ② 主进程**不得再出现** `DASHBOARD_FRESH_MS` —— 防止有人为新功能再写第二份阈值，
 *      把已经消失的漂移风险请回来。
 *
 * （文件名中的 `parity` 是历史遗留：它原先是"两侧同口径"的锁。）
 */
const ENGINES_TS = path.resolve(__dirname, '../../electron/ipc/engines.ts');

describe('新鲜度阈值单一来源锁', () => {
  const src = fs.readFileSync(ENGINES_TS, 'utf-8');

  it('唯一阈值 SCORE_FRESH_MS = 24h', () => {
    expect(SCORE_FRESH_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('该阈值真被陈旧判定消费（边界两侧行为不同，不是空壳常量）', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const within = new Date(now - SCORE_FRESH_MS + 60_000).toISOString();
    const beyond = new Date(now - SCORE_FRESH_MS - 60_000).toISOString();
    expect(scoreFreshness(within, now).stale).toBe(false);
    expect(scoreFreshness(beyond, now).stale).toBe(true);
  });

  it('主进程不得再引入第二份新鲜度阈值（六卡链路已整体删除）', () => {
    expect(src).not.toMatch(/DASHBOARD_FRESH_MS/);
  });
});
