import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { ScoringEngine } from '../engine';
import type { DimensionExtras } from '../types';

const emptyGuard = { results: [] as Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean }> };
const emptyInspect = { issues: [] as Array<{ severity: 'error' | 'warning' | 'info'; category: string }> };

const allExtras: DimensionExtras = {
  secrets: { activeCount: 0 },
  deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
  techdebt: { debtIndex: 0, issueCount: 0 },
  sentinel: { active: true, criticalEvents: 0, warningEvents: 0 },
  refactor: { totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 } },
  performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
};

describe('P1b 验收 — 未检测域不参与加权（spec G）', () => {
  it('deps null → dependencies not-run，overall 按剩余维度归一化', () => {
    const guard = { results: [{ severity: 'error' as const, status: 'failed' as const, blocking: true }] };
    const inspect = { issues: [{ severity: 'error' as const, category: 'quality' }] };
    const dims = buildHealthDimensions({ guard, inspect, extras: { deps: null } });

    const deps = dims.find((d) => d.name === 'dependencies')!;
    expect(deps.status).toBe('not-run');
    expect(deps.score).toBe(0);
    expect(deps.weight).toBe(0.1);

    const score = new ScoringEngine().calculate('p', dims);
    // quality 92 (0.10) + gate 92.9 (0.10)，weightSum 0.20 → 92.45
    expect(score.overall).toBe(92.45);
    // 若 dependencies 按满分 100 参与加权，overall = (92×0.10 + 92.9×0.10 + 100×0.10)/0.30 = 94.97
    // 实际 92.45 证明未检测域被排除在分子与分母之外
  });

  it('全部域未运行 → overall 0（weightSum 为 0 兜底）', () => {
    const dims = buildHealthDimensions({ guard: null, inspect: null });
    expect(dims.every((d) => d.status === 'not-run')).toBe(true);
    const score = new ScoringEngine().calculate('p', dims);
    expect(score.overall).toBe(0);
  });
});

describe('P1b 验收 — 总评分随单域变化可复算（spec G）', () => {
  it('同输入两次调用 overall 一致', () => {
    const guard = { results: [] as typeof emptyGuard.results };
    const inspect = { issues: [{ severity: 'warning' as const, category: 'quality' }] };
    const extras: DimensionExtras = {
      secrets: { activeCount: 1 },
      deps: { vulnerabilities: { critical: 0, high: 1, medium: 0 }, upgradable: 2 },
      techdebt: { debtIndex: 20, issueCount: 5 },
      sentinel: { active: true, criticalEvents: 0, warningEvents: 1 },
    };
    const s1 = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard, inspect, extras }),
    );
    const s2 = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard, inspect, extras }),
    );
    expect(s1.overall).toBe(s2.overall);
  });

  it('单域 issues/数据变化 → overall 单调变化', () => {
    const guard = { results: [] as typeof emptyGuard.results };
    const baseInspect = { issues: [{ severity: 'warning' as const, category: 'quality' }] };
    const base = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard, inspect: baseInspect, extras: allExtras }),
    ).overall;

    // 增加 security 问题 → 下降
    const worse = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({
        guard,
        inspect: {
          issues: [...baseInspect.issues, { severity: 'error' as const, category: 'security' }],
        },
        extras: allExtras,
      }),
    ).overall;
    expect(worse).toBeLessThan(base);

    // 增加 secrets 活跃数 → 下降
    const worseSecrets = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({
        guard,
        inspect: baseInspect,
        extras: { ...allExtras, secrets: { activeCount: 2 } },
      }),
    ).overall;
    expect(worseSecrets).toBeLessThan(base);

    // 增加 techdebt 指数 → 下降
    const worseDebt = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({
        guard,
        inspect: baseInspect,
        extras: { ...allExtras, techdebt: { debtIndex: 40, issueCount: 3 } },
      }),
    ).overall;
    expect(worseDebt).toBeLessThan(base);

    // 减少问题 → 上升
    const better = new ScoringEngine().calculate(
      'p',
      buildHealthDimensions({ guard, inspect: { issues: [] }, extras: allExtras }),
    ).overall;
    expect(better).toBeGreaterThan(base);
  });
});

describe('P1b 验收 — null vs 空数组（spec G）', () => {
  it('{ deps: null } → not-run；{ deps: 全 0 } → scored 且 100 分', () => {
    const notRun = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      extras: { deps: null },
    });
    expect(notRun.find((d) => d.name === 'dependencies')!.status).toBe('not-run');

    const scored = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      extras: { deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 } },
    });
    const deps = scored.find((d) => d.name === 'dependencies')!;
    expect(deps.status).toBe('scored');
    expect(deps.score).toBe(100);
  });
});

describe('P1b 验收 — 新扣分公式（spec D）', () => {
  it('secrets 扣分：active 每条 -15，上限 60（issues 由域快照条目承载，不加成）', () => {
    const dims = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      extras: { secrets: { activeCount: 4 } },
    });
    const security = dims.find((d) => d.name === 'security')!;
    expect(security.status).toBe('scored');
    expect(security.score).toBe(40); // 100 − min(60, 4×15)
    expect(security.issues).toBe(0); // P1-6: activeCount 不计入 issues，避免与 security 域快照双计
  });

  it('deps 扣分：critical -12 / high -8 / medium -4，upgradable 仅展示', () => {
    const dims = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      extras: { deps: { vulnerabilities: { critical: 1, high: 1, medium: 1 }, upgradable: 3 } },
    });
    const deps = dims.find((d) => d.name === 'dependencies')!;
    expect(deps.score).toBe(76); // 100 − (12+8+4)
    expect(deps.issues).toBe(0); // P1-6: upgradable 不计入 issues，改由 deps 域快照 upgrade:* 条目承载
  });

  it('techdebt 维 = 100 − debtIndex（固定口径，自身无 inspect 扣分）', () => {
    const dims = buildHealthDimensions({
      guard: emptyGuard,
      inspect: emptyInspect,
      extras: { techdebt: { debtIndex: 30, issueCount: 7 } },
    });
    const techdebt = dims.find((d) => d.name === 'techdebt')!;
    expect(techdebt.score).toBe(70);
    expect(techdebt.issues).toBe(7);
  });

  it('gate 维 = 100 − guardPenalty（v2 起哨兵拆出独立维，gate 不再吃哨兵事件）', () => {
    const dims = buildHealthDimensions({
      guard: { results: [{ severity: 'error' as const, status: 'failed' as const, blocking: true }] },
      inspect: emptyInspect,
      extras: { sentinel: { active: true, criticalEvents: 2, warningEvents: 1 } },
    });
    const gate = dims.find((d) => d.name === 'gate')!;
    expect(gate.score).toBe(92.9); // 100 − 7.06(guard，软饱和)，哨兵事件不再进 gate
    expect(gate.issues).toBe(1); // 仅 1 条 guard 检查项

    const sentinel = dims.find((d) => d.name === 'sentinel')!;
    expect(sentinel.status).toBe('scored');
    expect(sentinel.score).toBe(80.6); // 100 − (softBand(2,10,60)=15.0 + softBand(1,5,40)=4.44)
    expect(sentinel.issues).toBe(3);
  });

  it('gate 维不吃 skipped（让位）：后置门禁规则不该扣健康分', () => {
    const dims = buildHealthDimensions({
      guard: {
        results: [
          {
            severity: 'warning' as const,
            status: 'skipped' as const,
            blocking: false,
          },
        ],
      },
      inspect: emptyInspect,
    });
    const gate = dims.find((d) => d.name === 'gate')!;
    expect(gate.score).toBe(100);
    expect(gate.issues).toBe(0);
  });
});

describe('P1b 验收 — 各域未检测判定（spec C）', () => {
  it('quality: inspect null → not-run', () => {
    const dims = buildHealthDimensions({ guard: emptyGuard, inspect: null });
    expect(dims.find((d) => d.name === 'quality')!.status).toBe('not-run');
  });

  it('security: secrets null 且无 security issues → not-run；有 security issues → scored', () => {
    const noIssues = buildHealthDimensions({ guard: emptyGuard, inspect: emptyInspect });
    expect(noIssues.find((d) => d.name === 'security')!.status).toBe('not-run');
    const withIssues = buildHealthDimensions({
      guard: emptyGuard,
      inspect: { issues: [{ severity: 'error' as const, category: 'security' }] },
    });
    expect(withIssues.find((d) => d.name === 'security')!.status).toBe('scored');
  });

  it('dependencies: deps null 且无 dependency issues → not-run；有 dependency issues → scored', () => {
    const noIssues = buildHealthDimensions({ guard: emptyGuard, inspect: emptyInspect });
    expect(noIssues.find((d) => d.name === 'dependencies')!.status).toBe('not-run');
    const withIssues = buildHealthDimensions({
      guard: emptyGuard,
      inspect: { issues: [{ severity: 'warning' as const, category: 'dependency' }] },
    });
    expect(withIssues.find((d) => d.name === 'dependencies')!.status).toBe('scored');
  });

  it('techdebt: techdebt null → not-run', () => {
    const dims = buildHealthDimensions({ guard: emptyGuard, inspect: emptyInspect });
    expect(dims.find((d) => d.name === 'techdebt')!.status).toBe('not-run');
  });

  it('gate: guard null → not-run', () => {
    const dims = buildHealthDimensions({ guard: null, inspect: emptyInspect });
    expect(dims.find((d) => d.name === 'gate')!.status).toBe('not-run');
  });

  it('sentinel: extras.sentinel null → not-run；garbage/backup null → not-run', () => {
    const dims = buildHealthDimensions({ guard: emptyGuard, inspect: emptyInspect });
    expect(dims.find((d) => d.name === 'sentinel')!.status).toBe('not-run');
    expect(dims.find((d) => d.name === 'garbage')!.status).toBe('not-run');
    expect(dims.find((d) => d.name === 'backup')!.status).toBe('not-run');
  });
});