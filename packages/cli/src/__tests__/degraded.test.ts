import { describe, it, expect } from 'vitest';
import { countDegraded } from '../degraded';

// 复查4 P0 回归门禁：降级护栏的单一判定来源。
// 不变量：什么都没实际查 = 不得报通过。

describe('countDegraded — 各报告形态的降级信号提取', () => {
  it('Given RuleEngineReport（SOP 直接产出），When 顶层 degraded=6，Then 返回 6', () => {
    expect(countDegraded({ degraded: 6, evaluations: [], ok: false })).toBe(6);
  });

  it('Given InspectionReport，When adapterResults 含 2 个 degraded=true，Then 返回 2', () => {
    expect(
      countDegraded({
        adapterResults: [
          { adapterId: 'a', degraded: true, status: 'skipped' },
          { adapterId: 'b', degraded: false },
          { adapterId: 'c', degraded: true, status: 'skipped' },
          { adapterId: 'd' },
        ],
      }),
    ).toBe(2);
  });

  it('Given GuardReport 零结果空跑，When summary.total=0，Then 返回 1（盲检）', () => {
    expect(countDegraded({ results: [], summary: { total: 0, passed: 0, failed: 0 } })).toBe(1);
  });

  it('Given GuardReport 有真实结果，When summary.total>0，Then 返回 0', () => {
    expect(
      countDegraded({
        results: [{ checkId: 'x', status: 'passed' }],
        summary: { total: 1, passed: 1, failed: 0 },
      }),
    ).toBe(0);
  });

  it('Given 空值/非对象/无信号字段，Then 返回 0（RefactorReport 等形态不受影响）', () => {
    expect(countDegraded(null)).toBe(0);
    expect(countDegraded(undefined)).toBe(0);
    expect(countDegraded(42)).toBe(0);
    expect(countDegraded({})).toBe(0);
    expect(countDegraded({ files: [], bySeverity: {} })).toBe(0);
  });

  it('Given degraded 为非数值字段，When adapterResults 缺失，Then 回落为 0 而非 NaN', () => {
    expect(countDegraded({ degraded: '6' })).toBe(0);
  });
});
