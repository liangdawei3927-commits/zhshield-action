import { describe, it, expect } from 'vitest';
import { computeRedLine, RED_LINE_CAP, SCORE_VERSION } from '../redline';
import { ScoringEngine } from '../engine';
import { buildHealthDimensions } from '../pipeline-score';
import type { DimensionExtras } from '../types';

const cleanGuard = { results: [] };
const cleanInspect = { issues: [] };

describe('computeRedLine — 红线事实判定', () => {
  it('无 extras / 无 critical 事实 → null', () => {
    expect(computeRedLine(undefined)).toBeNull();
    expect(computeRedLine({})).toBeNull();
    expect(
      computeRedLine({
        secrets: { activeCount: 0 },
        deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
        sentinel: { active: true, criticalEvents: 0, warningEvents: 3 },
      }),
    ).toBeNull();
  });

  it('活跃密钥未处理 → security 红线', () => {
    const rl = computeRedLine({ secrets: { activeCount: 3 } });
    expect(rl?.capped).toBe(true);
    expect(rl?.cap).toBe(RED_LINE_CAP);
    expect(rl?.reasons).toEqual([
      { domain: 'security', kind: 'activeSecrets', count: 3 },
    ]);
  });

  it('critical 依赖漏洞 → dependencies 红线', () => {
    const rl = computeRedLine({
      deps: { vulnerabilities: { critical: 2, high: 5, medium: 0 }, upgradable: 0 },
    });
    expect(rl?.reasons).toEqual([
      { domain: 'dependencies', kind: 'criticalVulns', count: 2 },
    ]);
  });

  it('critical 哨兵事件 → sentinel 红线（warning 不触发）', () => {
    const rl = computeRedLine({ sentinel: { active: true, criticalEvents: 1, warningEvents: 4 } });
    expect(rl?.reasons).toEqual([{ domain: 'sentinel', kind: 'criticalEvents', count: 1 }]);
  });

  it('多源同时触发 → reasons 聚合', () => {
    const rl = computeRedLine({
      secrets: { activeCount: 1 },
      deps: { vulnerabilities: { critical: 1, high: 0, medium: 0 }, upgradable: 0 },
    });
    expect(rl?.reasons).toHaveLength(2);
  });
});

describe('ScoringEngine.calculate — 红线封顶', () => {
  it('无红线 → overall 为纯加权平均，scoreVersion=2，redLine 缺省', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: cleanInspect,
      extras: { security: { activeCount: 0 } },
    });
    const score = new ScoringEngine().calculate('p', dims);
    expect(score.scoreVersion).toBe(SCORE_VERSION);
    expect(score.redLine).toBeUndefined();
    expect(score.overall).toBe(100);
  });

  it('存在 critical 密钥 → overall 被压到 ≤ 60 且 grade=D，redLine 附带原因', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: cleanInspect,
      extras: { secrets: { activeCount: 5 } },
    });
    const rl = computeRedLine({ secrets: { activeCount: 5 } });
    const score = new ScoringEngine().calculate('p', dims, rl);
    expect(score.overall).toBeLessThanOrEqual(60);
    expect(score.grade).toBe('D');
    expect(score.redLine?.reasons[0]).toEqual({
      domain: 'security',
      kind: 'activeSecrets',
      count: 5,
    });
  });

  it('各域都好但哨兵有 critical 事件 → 总评照样封顶（平均不背锅）', () => {
    const dims = buildHealthDimensions({
      guard: cleanGuard,
      inspect: cleanInspect,
      extras: { sentinel: { active: true, criticalEvents: 1, warningEvents: 0 } },
    });
    const rl = computeRedLine({ sentinel: { active: true, criticalEvents: 1, warningEvents: 0 } });
    const score = new ScoringEngine().calculate('p', dims, rl);
    expect(score.overall).toBeLessThanOrEqual(60);
  });
});

describe('SCORE_VERSION / 全域 extras 类型完整性', () => {
  it('SCORE_VERSION = 3', () => {
    expect(SCORE_VERSION).toBe(3);
  });

  it('garbage/backup extras 参与 extras 全量运行判定', () => {
    const extras: DimensionExtras = {
      garbage: { total: 0, byType: {} },
      backup: {
        lastSuccessAt: new Date().toISOString(),
        recentStatuses: ['success'],
        scheduleEnabled: false,
      },
    };
    const dims = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras });
    expect(dims.find((d) => d.name === 'garbage')!.status).toBe('scored');
    expect(dims.find((d) => d.name === 'backup')!.status).toBe('scored');
  });
});
