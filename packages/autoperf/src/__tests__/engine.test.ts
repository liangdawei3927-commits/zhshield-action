import { describe, it, expect } from 'vitest';
import { AutoPerfEngine } from '../engine';
import type { PerfBudget, PerfProbeResult } from '../types';

const BUDGETS: PerfBudget[] = [
  {
    ruleId: 'perf.budget.cold-start',
    name: '冷启动',
    thresholdMs: 5000,
    severity: 'error',
    description: '冷启动预算',
  },
];

function probe(probeName: string, elapsedMs: number): PerfProbeResult {
  return { probeName, elapsedMs, sampledAt: new Date() };
}

describe('AutoPerfEngine.evaluate', () => {
  it('未超预算 → 无 issue', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('coldScan', 1000)]);
    expect(issues).toHaveLength(0);
  });

  it('恰好等于阈值 → 无 issue（边界）', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('coldScan', 5000)]);
    expect(issues).toHaveLength(0);
  });

  it('超预算 2 倍 → error issue，ruleId/fingerprint/source 正确', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('coldScan', 10000)], { projectPath: '/proj' });
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.ruleId).toBe('perf.budget.cold-start');
    expect(issue.severity).toBe('error');
    expect(issue.category).toBe('performance');
    expect(issue.source).toBe('performance');
    expect(issue.fingerprint).toBe('perf.budget.cold-start:coldScan');
    expect(issue.file).toBe('/proj');
    expect(issue.autoFixable).toBe(false);
    expect(issue.message).toContain('超出 100%');
  });

  it('无 projectPath → file 为 <runtime>', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('coldScan', 10000)]);
    expect(issues[0].file).toBe('<runtime>');
  });

  it('无匹配 probe → 无 issue', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('memoryPeak', 999999)]);
    expect(issues).toHaveLength(0);
  });
});

describe('AutoPerfEngine DI', () => {
  it('注入 budgets 生效（覆盖默认）', () => {
    const engine = new AutoPerfEngine({ budgets: BUDGETS });
    const issues = engine.evaluate([probe('coldScan', 10000)]);
    expect(issues).toHaveLength(1);
  });

  it('注入 detectMachineProfile 生效', () => {
    const fakeProfile = {
      cores: 2,
      totalMemGb: 8,
      freeMemGb: 4,
      lowMemory: true,
      adapterParallelism: 2,
      turboConcurrency: 1,
      vitestMaxWorkers: 2,
    };
    const engine = new AutoPerfEngine({
      budgets: BUDGETS,
      detectMachineProfile: () => fakeProfile,
    });
    expect(engine.getMachineProfile()).toEqual(fakeProfile);
  });
});
