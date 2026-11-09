/**
 * R5 验收单测（评分口径统一与十域独立性修复）。
 *
 * 规格：`00-项目文档/04-架构重建蓝图/05-开发规格/R5-评分口径统一与独立性修复.md`
 *
 * 这里只钉 R5 新增的口径，不重复既有公式测试：
 * - A1/A2/A3/A4：同一密钥 / CVE / 可升级依赖只扣一次；
 * - A5：技术债参考化，不进总分/覆盖度；
 * - A6：总分 = Σ(计分类分 × 有效权重)；
 * - A8：短板等级（任一计分类 <60 → 最高 C，<75 → 最高 B）。
 */
import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { computeOverallSnapshot } from '../engine';
import type { DimensionExtras, DimensionScore } from '../types';

const cleanExtras: DimensionExtras = {
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

function findDim(dims: DimensionScore[], name: string): DimensionScore {
  const dim = dims.find((d) => d.name === name);
  if (!dim) throw new Error(`dimension ${name} not found`);
  return dim;
}

describe('R5 A1/A2/A3/A4 — 同一事实只计一次', () => {
  it('A3：active 密钥只走 secretsPenalty，secret: 条目不再条目级扣分', () => {
    const dims = buildHealthDimensions({
      guard: { results: [] },
      inspect: {
        issues: [{ severity: 'error', category: 'security', ruleId: 'secret:aws-key' }],
      },
      extras: { ...cleanExtras, secrets: { activeCount: 1 } },
    });
    const security = findDim(dims, 'security');
    // 100 − 15（secretsPenalty）；若条目级再扣 8 会变成 77
    expect(security.score).toBe(85);
    expect(security.issues).toBe(1);
  });

  it('A2：critical CVE 只走 depsPenalty，cve: 条目不再条目级扣分', () => {
    const dims = buildHealthDimensions({
      guard: { results: [] },
      inspect: {
        issues: [{ severity: 'error', category: 'dependency', ruleId: 'cve:CVE-2025-0001' }],
      },
      extras: {
        ...cleanExtras,
        deps: { vulnerabilities: { critical: 1, high: 0, medium: 0 }, upgradable: 0 },
      },
    });
    const deps = findDim(dims, 'dependencies');
    // 100 − 12（critical×12）；若条目级再扣 8 会变成 80
    expect(deps.score).toBe(88);
    expect(deps.issues).toBe(1);
  });

  it('A4：upgradable 条目不扣分，只保留 issues 计数', () => {
    const dims = buildHealthDimensions({
      guard: { results: [] },
      inspect: {
        issues: [{ severity: 'warning', category: 'dependency', ruleId: 'upgrade:react' }],
      },
      extras: {
        ...cleanExtras,
        deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 1 },
      },
    });
    const deps = findDim(dims, 'dependencies');
    expect(deps.score).toBe(100);
    expect(deps.issues).toBe(1);
  });

  it('penaltyExempt 显式标记同样生效（不依赖 ruleId 前缀）', () => {
    const dims = buildHealthDimensions({
      guard: { results: [] },
      inspect: {
        issues: [
          {
            severity: 'error',
            category: 'security',
            ruleId: 'custom-absolute',
            penaltyExempt: true,
          },
        ],
      },
      extras: { ...cleanExtras, secrets: { activeCount: 1 } },
    });
    const security = findDim(dims, 'security');
    expect(security.score).toBe(85);
    expect(security.issues).toBe(1);
  });
});

describe('R5 A5 — 技术债参考化', () => {
  it('techdebt 有分但 excludedFromOverall=true，且不改变总分/覆盖度', () => {
    const dims = buildHealthDimensions({
      guard: { results: [] },
      inspect: { issues: [] },
      extras: { ...cleanExtras, techdebt: { debtIndex: 100, issueCount: 10 } },
    });
    const techdebt = findDim(dims, 'techdebt');
    expect(techdebt.score).toBe(0);
    expect(techdebt.excludedFromOverall).toBe(true);

    const snapshot = computeOverallSnapshot(dims);
    expect(snapshot.overall).toBe(100);
    expect(snapshot.coverage).toEqual({ run: 9, total: 9, complete: true });
  });

  it('全 100 分记录里把 techdebt 改成 0 分，总分逐字节不变', () => {
    const withoutDebt = buildHealthDimensions({
      guard: { results: [] },
      inspect: { issues: [] },
      extras: { ...cleanExtras, techdebt: { debtIndex: 0, issueCount: 0 } },
    });
    const withDebt = buildHealthDimensions({
      guard: { results: [] },
      inspect: { issues: [] },
      extras: { ...cleanExtras, techdebt: { debtIndex: 100, issueCount: 10 } },
    });
    expect(computeOverallSnapshot(withoutDebt).overall).toBe(
      computeOverallSnapshot(withDebt).overall,
    );
  });
});

describe('R5 A6/A8 — 总分可复算与短板等级', () => {
  /** 构造 9 个计分维（不带 techdebt） */
  function scoredDims(scores: Record<string, number>): DimensionScore[] {
    const names = [
      'quality',
      'gate',
      'security',
      'dependencies',
      'refactor',
      'performance',
      'sentinel',
      'garbage',
      'backup',
    ];
    return names.map((name) => ({
      name,
      score: scores[name] ?? 100,
      weight: 0.1,
      issues: 0,
    }));
  }

  it('A6：总分 = Σ(score × 有效权重)，且有效权重和为 1', () => {
    const dims = scoredDims({ dependencies: 70, quality: 90 });
    const snapshot = computeOverallSnapshot(dims);
    const active = dims.filter((d) => d.status !== 'not-run');
    const weightSum = active.reduce((sum, d) => sum + d.weight, 0);
    const expected = active.reduce((sum, d) => sum + d.score * d.weight, 0) / weightSum;
    expect(snapshot.overall).toBeCloseTo(expected, 2);
    expect(snapshot.coverage).toEqual({ run: 9, total: 9, complete: true });
  });

  it('A8：8×100 + 1×0 → overall 88.89，但等级最高 C（不被平均分掩盖）', () => {
    const snapshot = computeOverallSnapshot(scoredDims({ dependencies: 0 }));
    expect(snapshot.overall).toBeCloseTo(88.89, 1);
    expect(snapshot.grade).toBe('C');
  });

  it('A8：任一计分类 <75 → 最高 B；全类 ≥75 才可能 A', () => {
    const cappedB = computeOverallSnapshot(scoredDims({ dependencies: 70 }));
    expect(cappedB.grade).toBe('B');

    const allHigh = computeOverallSnapshot(scoredDims({}));
    expect(allHigh.overall).toBe(100);
    expect(allHigh.grade).toBe('A');
  });

  it('A7：只跑 1 个计分域时 coverage 如实标 1/9，不冒充完整', () => {
    const dims = scoredDims({});
    for (const d of dims) {
      if (d.name !== 'quality') d.status = 'not-run';
    }
    const snapshot = computeOverallSnapshot(dims);
    expect(snapshot.coverage).toEqual({ run: 1, total: 9, complete: false });
    expect(snapshot.overall).toBe(100);
  });
});
