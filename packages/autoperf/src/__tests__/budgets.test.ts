import { describe, it, expect } from 'vitest';
import { loadPerfBudgets, DEFAULT_BUDGETS, defaultBudgetFilePath } from '../budgets';

describe('loadPerfBudgets', () => {
  it('解析默认预算文件 → 5 条预算', () => {
    const budgets = loadPerfBudgets();
    expect(budgets).toHaveLength(5);
  });

  it('默认预算与内置兜底一致（ruleId / 阈值 / 严重级）', () => {
    const budgets = loadPerfBudgets();
    expect(budgets.map((b) => b.ruleId)).toEqual(DEFAULT_BUDGETS.map((b) => b.ruleId));
    expect(budgets.map((b) => b.thresholdMs)).toEqual(DEFAULT_BUDGETS.map((b) => b.thresholdMs));
    expect(budgets.map((b) => b.severity)).toEqual(DEFAULT_BUDGETS.map((b) => b.severity));
  });

  it('包含计划中的 5 项预算', () => {
    const budgets = loadPerfBudgets();
    const byRule = Object.fromEntries(budgets.map((b) => [b.ruleId, b]));
    expect(byRule['perf.budget.cold-start'].thresholdMs).toBe(5000);
    expect(byRule['perf.budget.scan-thousand-files'].thresholdMs).toBe(30000);
    expect(byRule['perf.budget.event-loop-delay'].thresholdMs).toBe(16);
    expect(byRule['perf.budget.sentinel-idle-cpu'].thresholdMs).toBe(2);
    expect(byRule['perf.budget.memory-peak'].thresholdMs).toBe(4096);
  });

  it('文件缺失 → 返回默认预算', () => {
    const budgets = loadPerfBudgets('/nonexistent/perf-budgets.yaml');
    expect(budgets).toEqual(DEFAULT_BUDGETS);
  });

  it('默认预算文件路径指向 assets 目录', () => {
    expect(defaultBudgetFilePath()).toMatch(/assets\/perf-budgets\.yaml$/);
  });
});
