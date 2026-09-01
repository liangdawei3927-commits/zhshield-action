/**
 * evolve-hook.ts 单元测试
 * 验证 AutoPerf → evolve 经验库回写：映射规则、source='auto'、置信度、空报告短路。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoPerfReport, PerfBudget } from '../types';

const mockRecord = vi.fn();
const mockAdjust = vi.fn();

vi.mock('@zh/evolve', () => ({
  EvolveEngine: class {
    recordExperience = mockRecord;
    autoAdjustWeights = mockAdjust;
  },
}));

// 动态 import（evolve-hook 内惰性 import，需在 mock 生效后引入）
async function loadHook() {
  return await import('../evolve-hook');
}

function makeReport(
  issues: Array<{ ruleId: string; severity: string; message: string; fingerprint?: string }>,
): AutoPerfReport {
  return {
    probes: [],
    issues: issues.map((i) => ({
      id: 'i1',
      ruleId: i.ruleId,
      severity: i.severity as 'error' | 'warning',
      category: 'performance' as const,
      message: i.message,
      fingerprint: i.fingerprint ?? i.ruleId,
      source: 'performance' as const,
    })),
  } as unknown as AutoPerfReport;
}

describe('recordPerfExperience', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockAdjust.mockReset();
  });

  it('error issue → true-positive + 置信度 0.9', async () => {
    const { recordPerfExperience } = await loadHook();
    const report = makeReport([
      { ruleId: 'perf.budget.cold-start', severity: 'error', message: '冷启动超时' },
    ]);
    await recordPerfExperience('/proj', report);

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const entry = mockRecord.mock.calls[0][0];
    expect(entry.ruleId).toBe('perf.budget.cold-start');
    expect(entry.type).toBe('true-positive');
    expect(entry.source).toBe('auto');
    expect(entry.confidence).toBe(0.9);
    expect(entry.projectId).toBe('/proj');
    expect(entry.verified).toBe(false);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
  });

  it('warning issue → best-practice + 置信度 0.6', async () => {
    const { recordPerfExperience } = await loadHook();
    const report = makeReport([
      { ruleId: 'perf.budget.event-loop-delay', severity: 'warning', message: '事件循环延迟偏高' },
    ]);
    await recordPerfExperience('/proj', report);

    const entry = mockRecord.mock.calls[0][0];
    expect(entry.type).toBe('best-practice');
    expect(entry.confidence).toBe(0.6);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
  });

  it('多个 issue → 逐条回写 + 触发 autoAdjustWeights', async () => {
    const { recordPerfExperience } = await loadHook();
    const report = makeReport([
      { ruleId: 'perf.budget.cold-start', severity: 'error', message: 'a' },
      { ruleId: 'perf.budget.memory-peak', severity: 'warning', message: 'b' },
    ]);
    await recordPerfExperience('/proj', report);

    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
  });

  it('空报告 → 不调用 recordExperience / autoAdjustWeights', async () => {
    const { recordPerfExperience } = await loadHook();
    const report = makeReport([]);
    await recordPerfExperience('/proj', report);

    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it('fingerprint 缺失 → 用 ruleId 兜底作 pattern', async () => {
    const { recordPerfExperience } = await loadHook();
    const report = makeReport([
      { ruleId: 'perf.budget.cold-start', severity: 'error', message: 'a' },
    ]); // fingerprint 走默认 = ruleId
    await recordPerfExperience('/proj', report);

    const entry = mockRecord.mock.calls[0][0];
    expect(entry.pattern).toBe('perf.budget.cold-start');
  });
});
