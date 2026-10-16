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
    // security: 1 error → softBand(1,8,48)=6.86 → 93.1
    expect(byName.security.score).toBe(93.1);
    expect(byName.security.issues).toBe(1);
    // quality: arch warning(4) + perf error(8) + doc info(1) + test warning(4) + refactor error(8) + quality info(1) = 26 → 74
    expect(byName.quality.score).toBe(74);
    expect(byName.quality.issues).toBe(6);
    // dependencies: dependency warning → softBand(1,4,40)=3.64 → 96.4
    expect(byName.dependencies.score).toBe(96.4);
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
    // gate: softBand(1,8,60)=7.06 + softBand(1,4,40)=3.64 = 10.70 → 89.3，issues 2
    expect(byName.gate.score).toBe(89.3);
    expect(byName.gate.issues).toBe(2);
    expect(byName.quality.score).toBe(100);
    // guard 不再计入 security 维
    expect(byName.security.status).toBe('not-run');
  });

  it('security 三级同时打满仍不触底 0（软饱和渐近）', () => {
    // 软饱和各级渐近于 cap（error 48 + warning 40 + info 12），同时打满也为有限正分：
    // softBand(6,8,48)=24 + softBand(10,4,40)=20 + softBand(12,1,12)=6 = 50 → 50
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
    expect(dims.find((d) => d.name === 'security')!.score).toBe(50);
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
    // 1..6 条 error 软饱和扣分 6.86/12/16/19.2/21.82/24 → 93.1/88/84/80.8/78.2/76
    expect(scores).toEqual([93.1, 88, 84, 80.8, 78.2, 76]);
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
    // 未知档按 info：softBand(1,1,12)=0.92 + softBand(1,8,48)=6.86 = 7.78 → 92.2
    expect(score).toBe(92.2);
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
    // 软饱和 penalty = 6.8571(error) + 3.6364(warning) + 2.4(info) = 12.8935 → 87.1，issues 5
    expect(refactor.status).toBe('scored');
    expect(refactor.score).toBe(87.1);
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
    // penalty softBand(1,8,40)=6.67 + softBand(1,2,15)=1.76 + softBand(1,1,5)=0.83 = 9.27 → 90.7，issues 3
    expect(performance.status).toBe('scored');
    expect(performance.score).toBe(90.7);
    expect(performance.issues).toBe(3);
  });

  it('refactor 软饱和：error 20 → penalty 36.9 → 63.1（旧口径 160 触顶 0；原硬封顶恒 48）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 20, bySeverity: { error: 20, warning: 0, info: 0 } },
    }});
    const refactor = dims.find((d) => d.name === 'refactor')!;
    // softBand(20, 8, 48) = 160/(1+160/48) = 36.9231 → 63.1
    expect(refactor.score).toBe(63.1);
    expect(refactor.issues).toBe(20);
  });

  it('refactor 真实量级回归：403 warning + 19 info 不得触底 0（2026-09-22 修复）', () => {
    // zhihui-codeshield 实扫 shape：{ error:0, warning:403, info:19 }
    // 软饱和罚分 0 + 39.0315(warning) + 7.3548(info) = 46.3863 → 53.6
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 422, bySeverity: { error: 0, warning: 403, info: 19 } },
    }});
    const refactor = real.find((d) => d.name === 'refactor')!;
    expect(refactor.status).toBe('scored');
    expect(refactor.score).toBe(53.6);
    expect(refactor.issues).toBe(422);
  });

  it('refactor 封顶随 severity 单调递减（P2-4 回归）：error 级封顶不得低于 warning 级', () => {
    expect(REFACTOR_SEVERITY_CAP.error).toBeGreaterThan(REFACTOR_SEVERITY_CAP.warning);
    expect(REFACTOR_SEVERITY_CAP.warning).toBeGreaterThan(REFACTOR_SEVERITY_CAP.info);
    const capSum = Object.values(REFACTOR_SEVERITY_CAP).reduce((a, b) => a + b, 0);
    expect(capSum).toBe(100);
  });

  it('refactor 软饱和不触底：error/warning/info 各 100 时分数渐近但恒 > 0', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 300, bySeverity: { error: 100, warning: 100, info: 100 } },
    }});
    // 软饱和 45.2830 + 36.3636 + 10.7143 = 92.3609 → 7.6（cap 为渐近上界，永不触底 0）
    const score = dims.find((d) => d.name === 'refactor')!.score;
    expect(score).toBe(7.6);
    expect(score).toBeGreaterThan(0);
  });

  it('refactor 软饱和单调性：warning 计数增大分数严格下降，高量级仍不饱和', () => {
    const scoreAtWarning = (warning: number): number => {
      const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
        refactor: { totalSmells: warning, bySeverity: { error: 0, warning, info: 0 } },
      }});
      return dims.find((d) => d.name === 'refactor')!.score;
    };
    const s10 = scoreAtWarning(10);
    const s100 = scoreAtWarning(100);
    const s1000 = scoreAtWarning(1000);
    const s5000 = scoreAtWarning(5000);
    expect(s10).toBeGreaterThan(s100);
    expect(s100).toBeGreaterThan(s1000);
    expect(s1000).toBeGreaterThan(s5000);
  });

  it('refactor 渐近无下限：error/warning/info 各 1000 时分数仍严格 > 0', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      refactor: { totalSmells: 3000, bySeverity: { error: 1000, warning: 1000, info: 1000 } },
    }});
    const score = dims.find((d) => d.name === 'refactor')!.score;
    expect(score).toBeGreaterThan(0);
  });

  it('refactor 清理坏味道后分数回升（P2-5 回归）：减少 warning 必须提高分数', () => {
    const scoreFor = (warning: number, info: number): number => {
      const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
        refactor: { totalSmells: warning + info, bySeverity: { error: 0, warning, info } },
      }});
      return dims.find((d) => d.name === 'refactor')!.score;
    };
    // 修复前硬封顶：warning 均 ≥10 恒扣 40，清理 209→100 分数纹丝不动
    expect(scoreFor(209, 22)).toBeLessThan(scoreFor(100, 22));
  });

  it('performance 单级软饱和：high 100 → penalty 36.36 → 63.6（旧口径 400 触底 0）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 100,
        bySeverity: { critical: 0, high: 100, medium: 0, low: 0, info: 0 },
      },
    }});
    const performance = dims.find((d) => d.name === 'performance')!;
    expect(performance.score).toBe(63.6);
    expect(performance.issues).toBe(100);
  });

  it('performance 真实量级回归：45 high + 5 medium 不得触底 0（2026-09-22 P2-3 同批修复）', () => {
    // zhihui-codeshield 实扫 shape：{ critical:0, high:45, medium:5, low:0, info:0 }
    // 软饱和 softBand(45,4,40)=32.73 + softBand(5,2,15)=6 = 38.73 → 61.3（旧口径 190 → 100 → 0）
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 50,
        bySeverity: { critical: 0, high: 45, medium: 5, low: 0, info: 0 },
      },
    }});
    const performance = real.find((d) => d.name === 'performance')!;
    expect(performance.status).toBe('scored');
    expect(performance.score).toBe(61.3);
    expect(performance.issues).toBe(50);
  });

  it('performance 五级全部打满仍为有限正分（软饱和渐近 cap 100）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      performance: {
        total: 500,
        bySeverity: { critical: 100, high: 100, medium: 100, low: 100, info: 100 },
      },
    }});
    // 软饱和各级渐近 cap：38.10+36.36+13.95+4.76+0 = 93.17 → 6.8
    expect(dims.find((d) => d.name === 'performance')!.score).toBe(6.8);
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
  it('sentinel null → not-run；有事件 → 软饱和 critical/warning 计权', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    const sentinelNotRun = notRun.find((d) => d.name === 'sentinel')!;
    expect(sentinelNotRun.status).toBe('not-run');

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      sentinel: { active: true, criticalEvents: 1, warningEvents: 2 },
    }});
    const sentinel = dims.find((d) => d.name === 'sentinel')!;
    // penalty softBand(1,10,60)=8.57 + softBand(2,5,40)=8.0 = 16.57 → 83.4，issues 3
    expect(sentinel.status).toBe('scored');
    expect(sentinel.score).toBe(83.4);
    expect(sentinel.issues).toBe(3);
  });

  it('gate 不再吃哨兵事件（v2 拆分）：guard 干净时 gate=100，哨兵事件只罚 sentinel 维', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      sentinel: { active: true, criticalEvents: 2, warningEvents: 0 },
    }});
    expect(dims.find((d) => d.name === 'gate')!.score).toBe(100);
    expect(dims.find((d) => d.name === 'sentinel')!.score).toBe(85);
  });

  it('garbage null → not-run；按类型软饱和计权扣分', () => {
    const notRun = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect });
    expect(notRun.find((d) => d.name === 'garbage')!.status).toBe('not-run');

    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: {
        total: 6,
        byType: { 'build-artifact': 1, 'unused-file': 1, 'dead-code': 1 },
      },
    }});
    const garbage = dims.find((d) => d.name === 'garbage')!;
    // penalty softBand(1,1,10)=0.91 + softBand(1,2,15)=1.76 + softBand(1,4,25)=3.45 = 6.12 → 93.9，issues 3（total 字段口径为条目总数）
    expect(garbage.status).toBe('scored');
    expect(garbage.score).toBe(93.9);
    expect(garbage.issues).toBe(6);
  });

  it('garbage 未知类型按缺省 2 分计权（缺省封顶 10）', () => {
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 3, byType: { 'mystery-type': 3 } },
    }});
    expect(dims.find((d) => d.name === 'garbage')!.score).toBe(96.3);
  });

  it('garbage 单类型封顶：单类型堆积不再把整维砸到 0（章程 P2-3 初校）', () => {
    // 100 个 unused-dependency：softBand(100,6,30)=28.57 → 71.4（旧口径触底 0）
    const heavy = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 100, byType: { 'unused-dependency': 100 } },
    }});
    expect(heavy.find((d) => d.name === 'garbage')!.score).toBe(71.4);

    // 100 个 build-artifact：单元最轻 → softBand(100,1,10)=9.09 → 90.9
    const artifacts = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: { total: 100, byType: { 'build-artifact': 100 } },
    }});
    expect(artifacts.find((d) => d.name === 'garbage')!.score).toBe(90.9);
  });

  it('garbage 真实量级回归：百级死代码/重复代码项目不得触底 0（2026-09-22 修复）', () => {
    // zhihui-codeshield 实扫 shape：{ build-artifact:1, unused-file:63, dead-code:468, duplicate-code:616 }
    // 软饱和 softBand(1,1,10)+softBand(63,2,15)+softBand(468,4,25)+softBand(616,3,20) = 58.77 → 41.2（旧口径 3847 → 100 → 0）
    const real = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras: {
      garbage: {
        total: 1148,
        byType: { 'build-artifact': 1, 'unused-file': 63, 'dead-code': 468, 'duplicate-code': 616 },
      },
    }});
    const garbage = real.find((d) => d.name === 'garbage')!;
    expect(garbage.status).toBe('scored');
    expect(garbage.score).toBe(41.2);
    expect(garbage.issues).toBe(1148);
  });

  it('garbage 五类型全部打满仍为有限正分（软饱和渐近，触底不为负）', () => {
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
    // 软饱和各级渐近 cap：9.09+13.95+18.75+23.53+28.57 = 93.89 → 6.1
    expect(dims.find((d) => d.name === 'garbage')!.score).toBe(6.1);
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