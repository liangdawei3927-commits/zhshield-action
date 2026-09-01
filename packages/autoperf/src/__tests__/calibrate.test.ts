/**
 * calibrateBudgets 单元测试
 * 验证预算随版本自动校准：中位数上浮 10%、anchorMs 下限、5x 上限、无历史/无 anchor 原样返回。
 */
import { describe, it, expect } from 'vitest';
import { calibrateBudgets } from '../budgets';
import type { PerfBudget } from '../types';

function makeBudget(overrides: Partial<PerfBudget> = {}): PerfBudget {
  return {
    ruleId: 'perf.budget.cold-start',
    name: '冷启动',
    thresholdMs: 5000,
    anchorMs: 3000,
    severity: 'error',
    description: 'd',
    ...overrides,
  };
}

describe('calibrateBudgets', () => {
  it('有历史 → threshold 调整为中位数上浮 10%', () => {
    const budgets = [makeBudget()];
    const history = [
      { name: 'perf.budget.cold-start', elapsed: 2000 },
      { name: 'perf.budget.cold-start', elapsed: 4000 },
      { name: 'perf.budget.cold-start', elapsed: 6000 },
    ];
    // 中位数=4000，×1.1=4400 > anchorMs(3000)
    const result = calibrateBudgets(budgets, history);
    expect(result[0].thresholdMs).toBe(4400);
  });

  it('校准值低于 anchorMs → 取 anchorMs 下限', () => {
    const budgets = [makeBudget()];
    const history = [{ name: 'perf.budget.cold-start', elapsed: 500 }];
    // 中位数=500，×1.1=550 < anchorMs(3000) → 取 3000
    const result = calibrateBudgets(budgets, history);
    expect(result[0].thresholdMs).toBe(3000);
  });

  it('校准值超过 anchorMs*5 → 取上限', () => {
    const budgets = [makeBudget()];
    const history = [{ name: 'perf.budget.cold-start', elapsed: 20000 }];
    // 中位数=20000，×1.1=22000 > anchorMs*5(15000) → 取 15000
    const result = calibrateBudgets(budgets, history);
    expect(result[0].thresholdMs).toBe(15000);
  });

  it('无历史 → threshold 不变', () => {
    const budgets = [makeBudget()];
    const result = calibrateBudgets(budgets, []);
    expect(result[0].thresholdMs).toBe(5000);
  });

  it('无 anchorMs → threshold 不变', () => {
    const budgets = [makeBudget({ anchorMs: undefined })];
    const history = [{ name: 'perf.budget.cold-start', elapsed: 9000 }];
    const result = calibrateBudgets(budgets, history);
    expect(result[0].thresholdMs).toBe(5000);
  });
});
