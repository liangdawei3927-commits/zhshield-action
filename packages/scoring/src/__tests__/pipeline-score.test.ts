import { describe, it, expect } from 'vitest';
import {
  buildHealthDimensions,
  PERFORMANCE_SEVERITY_CAP,
  REFACTOR_SEVERITY_CAP,
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
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: allExtras });
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
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    const sum = dims.reduce((acc, d) => acc + d.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('maps inspect issues to their dimension by category', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: {
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
      extras: allExtras,
    });

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
    const dims = buildHealthDimensions({
      guard: {
        results: [
          { severity: 'error' as const, status: 'failed' as const, blocking: true },
          { severity: 'warning' as const, status: 'warning' as const, blocking: false },
          { severity: 'info' as const, status: 'passed' as const, blocking: false },
        ],
      },
      inspect: cleanInspect,
    });

    const byName = Object.fromEntries(dims.map((d) => [d.name, d]));
    // gate: failed(8) + warning(4) = 12 → 88，issues 2
    expect(byName.gate.score).toBe(88);
    expect(byName.gate.issues).toBe(2);
    expect(byName.quality.score).toBe(100);
    // guard 不再计入 security 维
    expect(byName.security.status).toBe('not-run');
  });

  it('floors dimension score at 0', () => {
    // 三级封顶 Σ=100（error 48 + warning 40 + info 12），故触底需各级同时打满：
    // 6 error(48) + 10 warning(40) + 12 info(12) = 100 → 0
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: {
        issues: [
          ...Array.from({ length: 6 }, () => ({ severity: 'error' as const, category: 'security' })),
          ...Array.from({ length: 10 }, () => ({ severity: 'warning' as const, category: 'security' })),
          ...Array.from({ length: 12 }, () => ({ severity: 'info' as const, category: 'security' })),
        ],
      },
    });
    expect(dims.find((d) => d.name === 'security')!.score).toBe(0);
  });

  it('security 分辨率不再归零（P2-4 回归）：error 6→12 条期间分数必须逐条下降', () => {
    // 旧口径线性累加：error 第 13 条（13×8=104）即触底 0，之后恒为 0，
    // 用户修完问题看不到分数回升。单级封顶后 error 级内 1..6 条仍有分辨率。
    const scoreAt = (errorCount: number): number => {
      const built = buildHealthDimensions({
        guard: cleanGuard,
        inspect: {
          issues: Array.from({ length: errorCount }, () => ({
            severity: 'error' as const,
            category: 'security',
          })),
        },
      });
      return built.find((d) => d.name === 'security')!.score;
    };
    const scores = [1, 2, 3, 4, 5, 6].map(scoreAt);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    // 1..6 条 error → 8/16/24/32/40/48 扣分 → 92/84/76/68/60/52
    expect(scores).toEqual([92, 84, 76, 68, 60, 52]);
  });

  it('未知 severity 不产出 NaN（P2-4 回归）：落盘脏数据按 info 计，分数仍是有限值', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: {
        issues: [
          // 落盘快照来自旧版本/外部改写，severity 越界
          { severity: 'critical' as 'error', category: 'security' },
          { severity: 'error' as const, category: 'security' },
        ],
      },
    });
    const score = dims.find((d) => d.name === 'security')!.score;
    expect(Number.isFinite(score)).toBe(true);
    // 未知档按 info(1) + error(8) = 9 → 91
    expect(score).toBe(91);
  });
});

describe('P2 refactor/performance 维度（spec 新增）', () => {
  it('refactor null → not-run；有数据 → 按 severity 计权扣分', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    const refactorNotRun = notRun.find((d) => d.name === 'refactor')!;
    expect(refactorNotRun.status).toBe('not-run');
    expect(refactorNotRun.score).toBe(0);

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 5, bySeverity: { error: 1, warning: 1, info: 3 } },
    }});
    const refactor = dims.find((d) => d.name === 'refactor')!;
    // penalty 8+4+3 = 15 → 85，issues 5
    expect(refactor.status).toBe('scored');
    expect(refactor.score).toBe(85);
    expect(refactor.issues).toBe(5);
  });

  it('performance null → not-run；有数据 → 按 5 级 severity 计权扣分', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    const perfNotRun = notRun.find((d) => d.name === 'performance')!;
    expect(perfNotRun.status).toBe('not-run');
    expect(perfNotRun.score).toBe(0);

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: { total: 3, bySeverity: { critical: 1, high: 0, medium: 1, low: 1, info: 0 } },
    }});
    const performance = dims.find((d) => d.name === 'performance')!;
    // penalty 8+2+1 = 11 → 89，issues 3
    expect(performance.status).toBe('scored');
    expect(performance.score).toBe(89);
    expect(performance.issues).toBe(3);
  });

  it('refactor 单级封顶：error 20 → penalty 48 → 52（旧口径 160 触顶 0）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 20, bySeverity: { error: 20, warning: 0, info: 0 } },
    }});
    const refactor = dims.find((d) => d.name === 'refactor')!;
    expect(refactor.score).toBe(52);
    expect(refactor.issues).toBe(20);
  });

  it('refactor 真实量级回归：403 warning + 19 info 不得触底 0（2026-09-22 修复）', () => {
    // zhihui-codeshield 实扫 shape：{ error:0, warning:403, info:19 }
    // 罚分 min(48,0) + min(40,1612) + min(12,19) = 52 → 48（旧口径 1631 → 100 → 0）
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 422, bySeverity: { error: 0, warning: 403, info: 19 } },
    }});
    const refactor = real.find((d) => d.name === 'refactor')!;
    expect(refactor.status).toBe('scored');
    expect(refactor.score).toBe(48);
    expect(refactor.issues).toBe(422);
  });

  it('refactor 封顶随 severity 单调递减（P2-4 回归）：error 级封顶不得低于 warning 级', () => {
    expect(REFACTOR_SEVERITY_CAP.error).toBeGreaterThan(REFACTOR_SEVERITY_CAP.warning);
    expect(REFACTOR_SEVERITY_CAP.warning).toBeGreaterThan(REFACTOR_SEVERITY_CAP.info);
    const capSum = Object.values(REFACTOR_SEVERITY_CAP).reduce((a, b) => a + b, 0);
    expect(capSum).toBe(100);
  });

  it('refactor 全局上限 100：error/warning/info 全部触顶叠加后仍封顶', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 300, bySeverity: { error: 100, warning: 100, info: 100 } },
    }});
    // 48 + 40 + 12 = 100 → 0
    expect(dims.find((d) => d.name === 'refactor')!.score).toBe(0);
  });

  it('performance 单级封顶：high 100 → penalty 40 → 60（旧口径 400 触底 0）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 100,
        bySeverity: { critical: 0, high: 100, medium: 0, low: 0, info: 0 },
      },
    }});
    const performance = dims.find((d) => d.name === 'performance')!;
    expect(performance.score).toBe(60);
    expect(performance.issues).toBe(100);
  });

  it('performance 真实量级回归：45 high + 5 medium 不得触底 0（2026-09-22 P2-3 同批修复）', () => {
    // zhihui-codeshield 实扫 shape：{ critical:0, high:45, medium:5, low:0, info:0 }
    // 罚分 min(40,0) + min(40,180) + min(15,10) + min(5,0) = 50 → 50（旧口径 190 → 100 → 0）
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 50,
        bySeverity: { critical: 0, high: 45, medium: 5, low: 0, info: 0 },
      },
    }});
    const performance = real.find((d) => d.name === 'performance')!;
    expect(performance.status).toBe('scored');
    expect(performance.score).toBe(50);
    expect(performance.issues).toBe(50);
  });

  it('performance 全局上限 100：五级全部触顶叠加后仍封顶', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 500,
        bySeverity: { critical: 100, high: 100, medium: 100, low: 100, info: 100 },
      },
    }});
    // 40 + 40 + 15 + 5 + 0 = 100 → 0
    expect(dims.find((d) => d.name === 'performance')!.score).toBe(0);
  });

  it('performance 封顶对齐不变量：Σ 各 severity 封顶 === 100', () => {
    const capSum = Object.values(PERFORMANCE_SEVERITY_CAP).reduce((a, b) => a + b, 0);
    expect(capSum).toBe(100);
  });

  it('权重 sanity：十域等权各 0.10', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: allExtras });
    for (const dim of dims) {
      expect(dim.weight).toBe(0.1);
    }
  });
});

describe('十域评分体系 v2（sentinel/garbage/backup）', () => {
  it('sentinel null → not-run；有事件 → critical -10 / warning -5', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    const sentinelNotRun = notRun.find((d) => d.name === 'sentinel')!;
    expect(sentinelNotRun.status).toBe('not-run');

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      sentinel: { active: true, criticalEvents: 1, warningEvents: 2 },
    }});
    const sentinel = dims.find((d) => d.name === 'sentinel')!;
    // penalty 10 + 10 = 20 → 80，issues 3
    expect(sentinel.status).toBe('scored');
    expect(sentinel.score).toBe(80);
    expect(sentinel.issues).toBe(3);
  });

  it('gate 不再吃哨兵事件（v2 拆分）：guard 干净时 gate=100，哨兵事件只罚 sentinel 维', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      sentinel: { active: true, criticalEvents: 2, warningEvents: 0 },
    }});
    expect(dims.find((d) => d.name === 'gate')!.score).toBe(100);
    expect(dims.find((d) => d.name === 'sentinel')!.score).toBe(80);
  });

  it('garbage null → not-run；按类型计权扣分（1/2/3/4/6）', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    expect(notRun.find((d) => d.name === 'garbage')!.status).toBe('not-run');

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: {
        total: 6,
        byType: { 'build-artifact': 1, 'unused-file': 1, 'dead-code': 1 },
      },
    }});
    const garbage = dims.find((d) => d.name === 'garbage')!;
    // penalty 1 + 2 + 4 = 7 → 93，issues 3（total 字段口径为条目总数）
    expect(garbage.status).toBe('scored');
    expect(garbage.score).toBe(93);
    expect(garbage.issues).toBe(6);
  });

  it('garbage 未知类型按缺省 2 分计权（缺省封顶 10）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 3, byType: { 'mystery-type': 3 } },
    }});
    expect(dims.find((d) => d.name === 'garbage')!.score).toBe(94);
  });

  it('garbage 单类型封顶：单类型堆积不再把整维砸到 0（章程 P2-3 初校）', () => {
    // 100 个 unused-dependency：6×100=600 → 单类型封顶 30 → 70（旧口径触底 0）
    const heavy = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 100, byType: { 'unused-dependency': 100 } },
    }});
    expect(heavy.find((d) => d.name === 'garbage')!.score).toBe(70);

    // 100 个 build-artifact：单元最轻 → 封顶 10 → 90
    const artifacts = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 100, byType: { 'build-artifact': 100 } },
    }});
    expect(artifacts.find((d) => d.name === 'garbage')!.score).toBe(90);
  });

  it('garbage 真实量级回归：百级死代码/重复代码项目不得触底 0（2026-09-22 修复）', () => {
    // zhihui-codeshield 实扫 shape：{ build-artifact:1, unused-file:63, dead-code:468, duplicate-code:616 }
    // 罚分 1 + min(15,126) + min(25,1872) + min(20,1848) = 61 → 39（旧口径 3847 → 100 → 0）
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: {
        total: 1148,
        byType: { 'build-artifact': 1, 'unused-file': 63, 'dead-code': 468, 'duplicate-code': 616 },
      },
    }});
    const garbage = real.find((d) => d.name === 'garbage')!;
    expect(garbage.status).toBe('scored');
    expect(garbage.score).toBe(39);
    expect(garbage.issues).toBe(1148);
  });

  it('garbage 全局上限 100：五类型全部触顶叠加后仍封顶（触底不为负）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: {
        total: 1000,
        byType: {
          'build-artifact': 100,
          'unused-file': 100,
          'duplicate-code': 100,
          'dead-code': 100,
          'unused-dependency': 100,
        },
      },
    }});
    // 10 + 15 + 20 + 25 + 30 = 100 → 0
    expect(dims.find((d) => d.name === 'garbage')!.score).toBe(0);
  });

  it('backup null → not-run；新鲜度 + 失败率健康度', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    expect(notRun.find((d) => d.name === 'backup')!.status).toBe('not-run');

    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    // 7 天内成功 + 无失败 → 100
    const fresh = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      backup: { lastSuccessAt: daysAgo(2), recentStatuses: ['success', 'success'], scheduleEnabled: true },
    }});
    expect(fresh.find((d) => d.name === 'backup')!.score).toBe(100);

    // 7–30 天成功 −20；近 10 条失败率 50% × 30 = 15 → 65
    const stale = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      backup: {
        lastSuccessAt: daysAgo(15),
        recentStatuses: ['failed', 'success', 'failed', 'success'],
        scheduleEnabled: true,
      },
    }});
    expect(stale.find((d) => d.name === 'backup')!.score).toBe(65);

    // 从未成功 −40；唯一一条记录失败 1/1×30 = 30 → 100 − 70 = 30
    const never = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      backup: { lastSuccessAt: null, recentStatuses: ['failed'], scheduleEnabled: true },
    }});
    expect(never.find((d) => d.name === 'backup')!.score).toBe(30);
  });

  describe('S1 规则聚合 + 单规则封顶（章程修正①）', () => {
    it('同 ruleId 聚合计数：3 条同规则 error（24）封顶为 20，不再逐处扣分', () => {
      const dims = buildHealthDimensions({
        guard: cleanGuard,
        inspect: {
          issues: [
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
          ],
        },
      });
      const quality = dims.find((d) => d.name === 'quality')!;
      // 3×8 = 24 → cap 20 → 100 − 20 = 80
      expect(quality.score).toBe(80);
      expect(quality.issues).toBe(3);
    });

    it('不同规则各自独立封顶：R1×3 error（20）+ R2×1 error（8）= 28', () => {
      const dims = buildHealthDimensions({
        guard: cleanGuard,
        inspect: {
          issues: [
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R2' },
          ],
        },
      });
      expect(dims.find((d) => d.name === 'quality')!.score).toBe(72);
    });

    it('无 ruleId 的 issue 各自独立（单条 ≤8 < cap 20，行为与线性口径一致）', () => {
      const dims = buildHealthDimensions({
        guard: cleanGuard,
        inspect: {
          issues: [
            { severity: 'error' as const, category: 'quality' },
            { severity: 'error' as const, category: 'quality' },
            { severity: 'warning' as const, category: 'quality' },
          ],
        },
      });
      // 8+8+4 = 20 → 80，与 S1 引入前的线性扣分相同
      expect(dims.find((d) => d.name === 'quality')!.score).toBe(80);
    });
  });

  describe('S2 ESLOC 密度归一化（章程修正②）', () => {
    it('esloc 超过 DENSITY_REF_ESLOC → 按 REF/esloc 稀释：3 条同规则 error 聚合 20 × 0.5 = 10', () => {
      const dims = buildHealthDimensions({
        guard: cleanGuard,
        inspect: {
          issues: [
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
            { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
          ],
          esloc: 40_000,
        },
      });
      // 20 × (20000/40000 = 0.5) = 10 → 90
      expect(dims.find((d) => d.name === 'quality')!.score).toBe(90);
    });

    it('esloc 缺失/非法/小于 REF → 因子 1，不稀释也不放大', () => {
      const issues = [
        { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
        { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
        { severity: 'error' as const, category: 'quality', ruleId: 'R1' },
      ];
      const capped = 20;
      // 无 esloc → 因子 1
      const missing = buildHealthDimensions({ guard: cleanGuard, inspect: { issues } });
      expect(missing.find((d) => d.name === 'quality')!.score).toBe(100 - capped);
      // esloc = 0 → 因子 1（不放大）
      const zero = buildHealthDimensions({ guard: cleanGuard, inspect: { issues, esloc: 0 } });
      expect(zero.find((d) => d.name === 'quality')!.score).toBe(100 - capped);
      // esloc < REF → min(1, 20000/1000=20) = 1（不放大）
      const small = buildHealthDimensions({ guard: cleanGuard, inspect: { issues, esloc: 1_000 } });
      expect(small.find((d) => d.name === 'quality')!.score).toBe(100 - capped);
    });
  });
});