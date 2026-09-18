import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCORE_FRESH_MS } from '../pages/reports-logic';

/**
 * 新鲜度阈值「同口径」锁
 *
 * 背景：总分新鲜度（渲染进程 `SCORE_FRESH_MS`）与仪表盘卡片新鲜度
 * （主进程 `DASHBOARD_FRESH_MS`）都表达同一件事 —— **结果距今超过 24h 即陈旧**。
 * 但两者各自独立写成 `24 * 60 * 60 * 1000`：一个是渲染进程常量、一个是主进程常量，
 * 中间没有任何机制保证一致。任何一侧单独调整（比如为了少打扰用户改成 48h），
 * 另一侧会**静默漂移** —— 仪表盘说"已过期"、报告中心说"数据新鲜"，
 * 而两处代码看上去都对。
 *
 * 这类分叉单测抓不到（要同时跑起主进程与渲染进程才能观察到），因此在这里
 * 用结构断言钉死：主进程源码里的字面量必须与 `SCORE_FRESH_MS` 数值一致。
 * 与 `arch-layers-parity` / `secret-patterns-parity` 同一思路。
 *
 * 附带的第二层断言：`DASHBOARD_FRESH_MS` 必须**真的被使用**（出现 ≥2 次：
 * 定义 + 引用），防住「声明了却没被消费」的空壳常量。
 */
const ENGINES_TS = path.resolve(__dirname, '../../electron/ipc/engines.ts');

describe('新鲜度阈值同口径锁', () => {
  const src = fs.readFileSync(ENGINES_TS, 'utf-8');

  it('主进程 DASHBOARD_FRESH_MS 与渲染进程 SCORE_FRESH_MS 数值一致', () => {
    const m = src.match(/const\s+DASHBOARD_FRESH_MS\s*=\s*([0-9][0-9_*\s]*);/);
    expect(m, `未在 electron/ipc/engines.ts 找到 DASHBOARD_FRESH_MS 定义`).toBeTruthy();

    // 常量以 `a * b * c` 乘积形式书写：按因子相乘比较数值，避免 eval
    const value = m![1]
      .replace(/[_\s]/g, '')
      .split('*')
      .reduce((acc, factor) => acc * Number(factor), 1);

    expect(value, '主进程与渲染进程的 24h 新鲜度阈值已漂移').toBe(SCORE_FRESH_MS);
    expect(value).toBe(24 * 60 * 60 * 1000);
  });

  it('DASHBOARD_FRESH_MS 不得沦为「声明了却没消费」的空壳常量', () => {
    const occurrences = src.match(/DASHBOARD_FRESH_MS/g) ?? [];
    expect(occurrences.length, '只出现 1 次 = 只有定义、无人引用').toBeGreaterThanOrEqual(2);
  });
});
