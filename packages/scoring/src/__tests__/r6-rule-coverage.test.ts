/**
 * R6 验收：规则级覆盖度（未检测不冒充满分）。
 *
 * 锁四件事：
 * 1) quality 维把规则执行账转成 coverage（run=evaluated / total / complete）；
 * 2) 未执行规则**不改变分数**（未检测既不能当 0 分也不能当满分，契约 C4）；
 * 3) 旧报告没有规则账 → 不产 coverage（覆盖未知，不冒充完整也不判 partial）；
 * 4) `computeCoverage` 把维度内部缺口并入 `complete`，并列出 `partial` 维度名。
 */
import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { computeCoverage } from '../engine';
import type { DimensionExtras } from '../types';

const cleanGuard = { results: [] };

/** 全域已运行：避免 not-run 干扰覆盖度断言 */
const allExtras: DimensionExtras = {
  secrets: { activeCount: 0 },
  deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
  techdebt: { debtIndex: 0, issueCount: 0 },
  sentinel: { active: true, criticalEvents: 0, warningEvents: 0 },
  refactor: { totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 } },
  performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
  garbage: { total: 0, byType: {} },
  backup: {
    lastSuccessAt: new Date().toISOString(),
    recentStatuses: ['success'],
    scheduleEnabled: true,
  },
};

const ruleCoverage = (evaluated: number, unavailable: number) => ({
  total: evaluated + unavailable,
  evaluated,
  unavailable,
});

describe('R6 规则级覆盖度', () => {
  it('quality 维带 coverage；完整执行 → complete=true', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [], ruleCoverage: ruleCoverage(20, 0) },
      extras: allExtras,
    });
    const quality = dims.find((d) => d.name === 'quality')!;
    expect(quality.coverage).toEqual({ run: 20, total: 20, complete: true });
  });

  it('7 条未执行 → complete=false，但分数不变（未检测不扣分）', () => {
    const complete = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [], ruleCoverage: ruleCoverage(20, 0) },
      extras: allExtras,
    }).find((d) => d.name === 'quality')!;
    const partial = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [], ruleCoverage: ruleCoverage(13, 7) },
      extras: allExtras,
    }).find((d) => d.name === 'quality')!;
    expect(partial.coverage).toEqual({ run: 13, total: 20, complete: false });
    expect(partial.score).toBe(complete.score);
    expect(partial.score).toBe(100);
  });

  it('旧报告没有规则账 → 不产 coverage（覆盖未知，不判 partial）', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [] },
      extras: allExtras,
    });
    const quality = dims.find((d) => d.name === 'quality')!;
    expect(quality.coverage).toBeUndefined();
    expect(computeCoverage(dims).complete).toBe(true);
  });

  it('computeCoverage：维度内部缺口 → complete=false + partial 列出维度名', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [], ruleCoverage: ruleCoverage(13, 7) },
      extras: allExtras,
    });
    const coverage = computeCoverage(dims);
    expect(coverage.run).toBe(9);
    expect(coverage.total).toBe(9);
    expect(coverage.complete).toBe(false);
    expect(coverage.partial).toEqual(['quality']);
  });

  it('computeCoverage：全维完整 → complete=true 且无 partial', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: { issues: [], ruleCoverage: ruleCoverage(20, 0) },
      extras: allExtras,
    });
    const coverage = computeCoverage(dims);
    expect(coverage.complete).toBe(true);
    expect(coverage.partial).toBeUndefined();
  });
});
