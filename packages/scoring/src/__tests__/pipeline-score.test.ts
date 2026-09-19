import { describe, it, expect } from 'vitest';
import {
  buildHealthDimensions,
  type GuardReportLike,
  type InspectionReportLike,
} from '../pipeline-score';
import type { DimensionExtras } from '../types';

const cleanGuard: GuardReportLike = { results: [] };
const cleanInspect: InspectionReportLike = { issues: [] };

/** 全域已运行：所有扩展域提供数据，避免 not-run 干扰维度计分断言 */
const allExtras: DimensionExtras = {
  secrets: { activeCount: 0 },
  deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
  techdebt: { debtIndex: 0, issueCount: 0 },
  sentinel: { active: true, criticalEvents: 0, warningEvents: 0 },
  refactor: { totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 } },
  performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
  garbage: { total: 0, byType: {} },
  backup: { lastSuccessAt: new Date().toISOString(), recentStatuses: ['success'], scheduleEnabled: true },
};

describe('buildHealthDimensions', () => {
  it('all clean reports score 100 on every dimension', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, allExtras);
    expect(dims).toHaveLength(10);
    expect(dims.map((d) => d.name)).toEqual([
      'quality',
      'security',
      'dependencies',
      'refactor',
      'performance',
      'techdebt',
      'gate',
      'sentinel',
      'garbage',
      'backup',
    ]);
    expect(dims.every((d) => d.score === 100)).toBe(true);
    expect(dims.every((d) => d.issues === 0)).toBe(true);
  });

  it('dimension weights sum to 1', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect);
    const sum = dims.reduce((acc, d) => acc + d.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('maps inspect issues to their dimension by category', () => {
    const dims = buildHealthDimensions(
      cleanGuard,
      {
        issues: [
          { severity: 'error' as const, category: 'security' },
          { severity: 'warning' as const, category: 'architecture' },
          { severity: 'error' as const, category: 'performance' },
          { severity: 'info' as const, category: 'documentation' },
          { severity: 'warning' as const, category: 'test' },
          { severity: 'error' as const, category: 'refactoring' },
          { severity: 'warning' as const, category: 'dependency' },
          { severity: 'info' as const, category: 'quality' },
        ],
      },
      undefined,
      undefined,
      allExtras,
    );

    const byName = Object.fromEntries(dims.map((d) => [d.name, d]));
    // security: 1 error → 92
    expect(byName.security.score).toBe(92);
    expect(byName.security.issues).toBe(1);
    // quality: arch warning(4) + perf error(8) + doc info(1) + test warning(4) + refactor error(8) + quality info(1) = 26 → 74
    expect(byName.quality.score).toBe(74);
    expect(byName.quality.issues).toBe(6);
    // dependencies: dependency warning(4) → 96
    expect(byName.dependencies.score).toBe(96);
    expect(byName.dependencies.issues).toBe(1);
    // techdebt: debtIndex 0 → 100
    expect(byName.techdebt.score).toBe(100);
    expect(byName.techdebt.issues).toBe(0);
    // refactor: 无 smell → 100
    expect(byName.refactor.score).toBe(100);
    expect(byName.refactor.issues).toBe(0);
    // performance: 无性能问题 → 100
    expect(byName.performance.score).toBe(100);
    expect(byName.performance.issues).toBe(0);
    // gate: 无 guard 失败 → 100
    expect(byName.gate.score).toBe(100);
    expect(byName.gate.issues).toBe(0);
  });

  it('counts only non-passed guard results as gate issues', () => {
    const dims = buildHealthDimensions(
      {
        results: [
          { severity: 'error' as const, status: 'failed' as const, blocking: true },
          { severity: 'warning' as const, status: 'warning' as const, blocking: false },
          { severity: 'info' as const, status: 'passed' as const, blocking: false },
        ],
      },
      cleanInspect,
    );

    const byName = Object.fromEntries(dims.map((d) => [d.name, d]));
    // gate: failed(8) + warning(4) = 12 → 88，issues 2
    expect(byName.gate.score).toBe(88);
    expect(byName.gate.issues).toBe(2);
    expect(byName.quality.score).toBe(100);
    // guard 不再计入 security 维
    expect(byName.security.status).toBe('not-run');
  });

  it('floors dimension score at 0', () => {
    const dims = buildHealthDimensions(cleanGuard, {
      issues: Array.from({ length: 20 }, () => ({
        severity: 'error' as const,
        category: 'security',
      })),
    });
    expect(dims.find((d) => d.name === 'security')!.score).toBe(0);
  });
});

describe('P2 refactor/performance 维度（spec 新增）', () => {
  it('refactor null → not-run；有数据 → 按 severity 计权扣分', () => {
    const notRun = buildHealthDimensions(cleanGuard, cleanInspect);
    const refactorNotRun = notRun.find((d) => d.name === 'refactor')!;
    expect(refactorNotRun.status).toBe('not-run');
    expect(refactorNotRun.score).toBe(0);

    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      refactor: { totalSmells: 5, bySeverity: { error: 1, warning: 1, info: 3 } },
    });
    const refactor = dims.find((d) => d.name === 'refactor')!;
    // penalty 8+4+3 = 15 → 85，issues 5
    expect(refactor.status).toBe('scored');
    expect(refactor.score).toBe(85);
    expect(refactor.issues).toBe(5);
  });

  it('performance null → not-run；有数据 → 按 5 级 severity 计权扣分', () => {
    const notRun = buildHealthDimensions(cleanGuard, cleanInspect);
    const perfNotRun = notRun.find((d) => d.name === 'performance')!;
    expect(perfNotRun.status).toBe('not-run');
    expect(perfNotRun.score).toBe(0);

    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      performance: { total: 3, bySeverity: { critical: 1, high: 0, medium: 1, low: 1, info: 0 } },
    });
    const performance = dims.find((d) => d.name === 'performance')!;
    // penalty 8+2+1 = 11 → 89，issues 3
    expect(performance.status).toBe('scored');
    expect(performance.score).toBe(89);
    expect(performance.issues).toBe(3);
  });

  it('refactor 扣分上限 100：error 20 → score 0', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      refactor: { totalSmells: 20, bySeverity: { error: 20, warning: 0, info: 0 } },
    });
    const refactor = dims.find((d) => d.name === 'refactor')!;
    expect(refactor.score).toBe(0);
    expect(refactor.issues).toBe(20);
  });

  it('权重 sanity：十域等权各 0.10', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, allExtras);
    for (const dim of dims) {
      expect(dim.weight).toBe(0.1);
    }
  });
});

describe('十域评分体系 v2（sentinel/garbage/backup）', () => {
  it('sentinel null → not-run；有事件 → critical -10 / warning -5', () => {
    const notRun = buildHealthDimensions(cleanGuard, cleanInspect);
    const sentinelNotRun = notRun.find((d) => d.name === 'sentinel')!;
    expect(sentinelNotRun.status).toBe('not-run');

    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      sentinel: { active: true, criticalEvents: 1, warningEvents: 2 },
    });
    const sentinel = dims.find((d) => d.name === 'sentinel')!;
    // penalty 10 + 10 = 20 → 80，issues 3
    expect(sentinel.status).toBe('scored');
    expect(sentinel.score).toBe(80);
    expect(sentinel.issues).toBe(3);
  });

  it('gate 不再吃哨兵事件（v2 拆分）：guard 干净时 gate=100，哨兵事件只罚 sentinel 维', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      sentinel: { active: true, criticalEvents: 2, warningEvents: 0 },
    });
    expect(dims.find((d) => d.name === 'gate')!.score).toBe(100);
    expect(dims.find((d) => d.name === 'sentinel')!.score).toBe(80);
  });

  it('garbage null → not-run；按类型计权扣分（1/2/3/4/6）', () => {
    const notRun = buildHealthDimensions(cleanGuard, cleanInspect);
    expect(notRun.find((d) => d.name === 'garbage')!.status).toBe('not-run');

    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      garbage: {
        total: 6,
        byType: { 'build-artifact': 1, 'unused-file': 1, 'dead-code': 1 },
      },
    });
    const garbage = dims.find((d) => d.name === 'garbage')!;
    // penalty 1 + 2 + 4 = 7 → 93，issues 3（total 字段口径为条目总数）
    expect(garbage.status).toBe('scored');
    expect(garbage.score).toBe(93);
    expect(garbage.issues).toBe(6);
  });

  it('garbage 未知类型按缺省 2 分计权；扣分上限 100', () => {
    const dims = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      garbage: { total: 3, byType: { 'mystery-type': 3 } },
    });
    expect(dims.find((d) => d.name === 'garbage')!.score).toBe(94);

    const floored = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      garbage: { total: 100, byType: { 'unused-dependency': 100 } },
    });
    expect(floored.find((d) => d.name === 'garbage')!.score).toBe(0);
  });

  it('backup null → not-run；新鲜度 + 失败率健康度', () => {
    const notRun = buildHealthDimensions(cleanGuard, cleanInspect);
    expect(notRun.find((d) => d.name === 'backup')!.status).toBe('not-run');

    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    // 7 天内成功 + 无失败 → 100
    const fresh = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      backup: { lastSuccessAt: daysAgo(2), recentStatuses: ['success', 'success'], scheduleEnabled: true },
    });
    expect(fresh.find((d) => d.name === 'backup')!.score).toBe(100);

    // 7–30 天成功 −20；近 10 条失败率 50% × 30 = 15 → 65
    const stale = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      backup: {
        lastSuccessAt: daysAgo(15),
        recentStatuses: ['failed', 'success', 'failed', 'success'],
        scheduleEnabled: true,
      },
    });
    expect(stale.find((d) => d.name === 'backup')!.score).toBe(65);

    // 从未成功 −40；唯一一条记录失败 1/1×30 = 30 → 100 − 70 = 30
    const never = buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      backup: { lastSuccessAt: null, recentStatuses: ['failed'], scheduleEnabled: true },
    });
    expect(never.find((d) => d.name === 'backup')!.score).toBe(30);
  });
});