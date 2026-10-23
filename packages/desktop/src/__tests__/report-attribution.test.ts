/**
 * 分数变化归因的单测。
 *
 * 这里钉的不是「能不能算出数字」，而是**归因会不会骗人**。四条：
 *
 * 1. **恒等式必须闭合**：Σ域贡献 + 结构项 + 封顶项 ≡ 实际变化。
 *    拆完合不回去 = 公式有洞，这种归因比没有归因更坏（用户会照着错误结论去改代码）。
 * 2. **有效权重必须按参与域归一化**：只跑 9 个域时每域是 1/9 ≈ 11.1%，不是配置里的 10%。
 *    拿 0.1 硬乘会让「掉 10 分」少算 11%。
 * 3. **口径变化必须单列**：某域从 not-run 变成已检测，总分变化里有一部分不是任何域变好坏
 *    造成的 —— 那部分进结构项，不许摊给具体域。
 * 4. **算不了就说算不了**：跨评分版本 / 缺权重一律返回不可用，不臆造默认值、不显示 0。
 */

import { describe, expect, it } from 'vitest';
import type { HealthScoreData } from '../types/electron';
import {
  attributeRange,
  attributeScoreDelta,
  attributeWindowVsPrev,
  contributionShare,
  indexRecordsByTimestamp,
  isStructureDominated,
  RECONCILE_EPSILON,
  totalAbsolutePoints,
  type AttributionBreakdown,
} from '../pages/report-attribution';
import { buildWindowBuckets, summarizeWindows } from '../pages/report-windows';

/** 与 @zh/scoring 的 DIMENSION_CATEGORIES 同序的十域 */
const DOMAINS = [
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
] as const;

type DomainName = (typeof DOMAINS)[number];

interface RecordInput {
  timestamp: string;
  /** 各域分数，缺省 100 */
  scores?: Partial<Record<DomainName, number>>;
  /** 未检测的域（不参与加权） */
  notRun?: readonly DomainName[];
  /** 覆盖权重（默认 0.1） */
  weights?: Partial<Record<DomainName, number>>;
  scoreVersion?: number;
  redLine?: HealthScoreData['redLine'];
  /** 显式总分（模拟历史里那份已落库的分，可能与按域分重算略有差异） */
  overall?: number;
}

/**
 * 构造一条评分记录。
 *
 * 总分默认按**真实算法**算：not-run 剔除 → 按剩余权重归一化 → 可选封顶。
 * 这正是 `@zh/scoring` 的 computeOverall + applyRedLineCap，归因必须与它同口径。
 */
function makeRecord(input: RecordInput): HealthScoreData {
  const notRun = new Set(input.notRun ?? []);
  const dimensions = DOMAINS.map((name) => {
    const weight = input.weights?.[name] ?? 0.1;
    const score = input.scores?.[name] ?? 100;
    return notRun.has(name)
      ? { name, score: 0, weight, status: 'not-run' as const }
      : { name, score, weight };
  });
  const active = dimensions.filter((d) => d.status !== 'not-run');
  const weightSum = active.reduce((sum, d) => sum + d.weight, 0);
  const raw =
    weightSum > 0 ? active.reduce((sum, d) => sum + d.score * d.weight, 0) / weightSum : 0;
  const capped =
    input.redLine?.capped === true ? Math.min(raw, input.redLine.cap) : raw;
  const overall = input.overall ?? Math.round(capped * 100) / 100;
  return {
    score: overall,
    dimensions,
    summary: 'ok',
    timestamp: input.timestamp,
    ...(typeof input.scoreVersion === 'number' ? { scoreVersion: input.scoreVersion } : {}),
    ...(input.redLine ? { redLine: input.redLine } : {}),
  };
}

/** 断言归因可用并把类型收窄到 breakdown */
function expectBreakdown(result: ReturnType<typeof attributeScoreDelta>): AttributionBreakdown {
  if (!result.ok) throw new Error(`归因不可用: ${result.reason}`);
  return result;
}

/** 三项分解必须还原实际变化 */
function expectReconciled(result: AttributionBreakdown): void {
  expect(result.reconciled).toBe(true);
  expect(Math.abs(result.residual)).toBeLessThanOrEqual(RECONCILE_EPSILON);
  const sum = result.domainsPoints + result.structurePoints + result.capPoints;
  expect(result.actualDelta).toBeCloseTo(sum, 1);
}

describe('attributeScoreDelta — 基本归因', () => {
  const START = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
  const END = makeRecord({
    timestamp: '2026-10-02T10:00:00.000Z',
    scores: { security: 78.4, quality: 86, techdebt: 92 },
  });

  it('把总分变化拆到具体域，且三项相加等于实际变化', () => {
    const result = expectBreakdown(attributeScoreDelta(START, END));
    expectReconciled(result);
    expect(result.actualDelta).toBe(-4.4); // (78.4+86+92+700)/10 = 95.64 → -4.36 → 1 位 -4.4
    expect(result.domains[0].name).toBe('security');
    expect(result.domains[0].delta).toBe(-21.6);
    expect(result.domains[0].points).toBe(-2.16);
    expect(result.domains[1].points).toBe(-1.4);
    expect(result.domains[2].points).toBe(-0.8);
    // 参与域没变、权重没变、没封顶 ⇒ 结构项与封顶项必须为 0
    expect(result.structurePoints).toBe(0);
    expect(result.capPoints).toBe(0);
    expect(result.entered).toEqual([]);
    expect(result.exited).toEqual([]);
  });

  it('贡献按绝对值降序，未变化的域贡献为 0 而不是被丢掉', () => {
    const result = expectBreakdown(attributeScoreDelta(START, END));
    const magnitudes = result.domains.map((d) => Math.abs(d.points));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    expect(result.domains).toHaveLength(DOMAINS.length);
    expect(result.domains.filter((d) => d.points === 0)).toHaveLength(7);
  });

  it('十域满参与时有效权重就是配置权重 0.1（归一化分母为 1）', () => {
    const result = expectBreakdown(attributeScoreDelta(START, END));
    for (const domain of result.domains) expect(domain.effectiveWeight).toBeCloseTo(0.1, 10);
    expect(result.activeStart).toBe(10);
    expect(result.activeEnd).toBe(10);
  });
});

describe('attributeScoreDelta — 有效权重必须归一化（not-run 域退出分母）', () => {
  it('只跑 9 个域时，每个域的有效权重是 1/9 而不是 0.1', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', notRun: ['backup'] });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      notRun: ['backup'],
      scores: { security: 80 },
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    const security = result.domains.find((d) => d.name === 'security')!;
    expect(security.effectiveWeight).toBeCloseTo(1 / 9, 10);
    // 掉 20 分值 20/9 ≈ 2.22 分；若错用 0.1 硬乘只会算出 2.0（少算 11%）
    expect(security.points).toBeCloseTo(-2.22, 1);
    expect(security.points).not.toBeCloseTo(-2.0, 1);
    expectReconciled(result);
  });

  it('not-run 域不产生贡献（它的分数恒为 0，不许当成 0 分来归因）', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', notRun: ['backup'] });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      notRun: ['backup'],
      scores: { security: 90 },
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.domains.find((d) => d.name === 'backup')).toBeUndefined();
    expect(result.domains.some((d) => d.name === 'backup' && d.points < 0)).toBe(false);
  });
});

describe('attributeScoreDelta — 口径变化进结构项，不摊给具体域', () => {
  it('某域从 not-run 变成已检测：记进 entered，影响走结构项', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', notRun: ['backup'] });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      scores: { backup: 40 }, // 新参与，且分数很低
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.entered).toEqual(['backup']);
    expect(result.exited).toEqual([]);
    expect(result.activeStart).toBe(9);
    expect(result.activeEnd).toBe(10);
    // 新增域没有「上期分」，因此不产生域贡献
    expect(result.domains.find((d) => d.name === 'backup')).toBeUndefined();
    // 但总分确实掉了，这部分必须由结构项解释
    expect(result.actualDelta).toBeLessThan(0);
    expect(result.structurePoints).not.toBe(0);
    expectReconciled(result);
  });

  it('某域从已检测退成 not-run：记进 exited，影响走结构项', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', scores: { backup: 40 } });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z', notRun: ['backup'] });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.exited).toEqual(['backup']);
    expect(result.entered).toEqual([]);
    expect(result.domains.find((d) => d.name === 'backup')).toBeUndefined();
    expectReconciled(result);
  });

  it('画像调整导致权重变化：记进 weightChanged，差额由结构项吸收', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      weights: { security: 0.2, quality: 0.06 }, // 总权重和仍为 1，只是重新分配
      scores: { security: 90 },
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.weightChanged.sort()).toEqual(['quality', 'security']);
    expect(result.structurePoints).not.toBe(0);
    expectReconciled(result);
  });
});

describe('attributeScoreDelta — 红线封顶单列', () => {
  it('本期触发封顶：封顶项非 0，且不摊给任何域', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      scores: { security: 60 },
      redLine: { capped: true, cap: 45, reasons: [{ domain: 'security', kind: 'secret', count: 2 }] },
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.capped).toBe(true);
    // 按域分算应为 96（未封顶），实际记录 45 ⇒ 封顶吃掉 51 分
    expect(result.rawEndScore).toBe(96);
    expect(result.endScore).toBe(45);
    expect(result.capPoints).toBeCloseTo(-51, 0);
    // 域贡献仍然只反映域分本身的变化（-4），不含封顶
    expect(result.domainsPoints).toBe(-4);
    expectReconciled(result);
  });

  it('上期封顶、本期解除：封顶项为正，解释「分数为什么突然变高」', () => {
    const start = makeRecord({
      timestamp: '2026-10-01T10:00:00.000Z',
      scores: { security: 60 },
      redLine: { capped: true, cap: 45, reasons: [{ domain: 'security', kind: 'secret', count: 2 }] },
    });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z', scores: { security: 96 } });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.startScore).toBe(45);
    expect(result.endScore).toBe(99.6); // security 96 + 其余 900 → 99.6
    expect(result.capPoints).toBeCloseTo(51, 0);
    expectReconciled(result);
  });

  it('总分与域分不符且未声明封顶 ⇒ 判为未闭合，不许用「封顶」蒙过去', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    // 域分全是 100，总分却写 50，而 redLine 没有声明封顶
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z', overall: 50 });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.capped).toBe(false);
    // 封顶项不许背这个锅（否则任何写分错误都会被美化成「红线压制」）
    expect(result.capPoints).toBe(0);
    expect(result.reconciled).toBe(false);
    expect(result.residual).toBe(-50);
  });
});

describe('attributeScoreDelta — 算不了就说算不了', () => {
  it('跨评分版本不归因（维度集与扣分口径都变了）', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', scoreVersion: 1 });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z', scoreVersion: 2 });
    const result = attributeScoreDelta(start, end);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('version-mismatch');
    // 即使不可用，两端分与差值仍然给出（UI 要能显示「跨版本，不比较」）
    expect(result.startScore).toBe(100);
    expect(result.endScore).toBe(100);
  });

  it('权重缺失不臆造默认值', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      weights: { security: 0 },
    });
    const result = attributeScoreDelta(start, end);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('missing-weight');
  });

  it('维度集不同（不是 not-run，而是根本没有这一维）时不做归因', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z' });
    // 手工砍掉一维，模拟维度构成真的变了（not-run 不会这样：它仍留在数组里）
    const trimmed: HealthScoreData = {
      ...end,
      dimensions: end.dimensions.filter((d) => d.name !== 'backup'),
    };
    const result = attributeScoreDelta(start, trimmed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('dimension-set-mismatch');
  });

  it('一端全部未检测时无法加权', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z', notRun: [...DOMAINS] });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z' });
    const result = attributeScoreDelta(start, end);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no-active-dimension');
  });
});

describe('与其他口径对齐（防止报告中心出现两套数字）', () => {
  it('区间归因的 actualDelta 与 summarizeWindows().totalDelta 严格一致', () => {
    const data: HealthScoreData[] = [
      makeRecord({ timestamp: new Date(2026, 7, 30, 12).toISOString() }),
      makeRecord({
        timestamp: new Date(2026, 8, 5, 12).toISOString(),
        scores: { security: 70 },
      }),
      makeRecord({
        timestamp: new Date(2026, 8, 20, 12).toISOString(),
        scores: { security: 60, refactor: 88 },
      }),
      makeRecord({
        timestamp: new Date(2026, 9, 20, 12).toISOString(),
        scores: { security: 82, refactor: 100 },
      }),
    ];
    const buckets = buildWindowBuckets(data, 'month');
    const summary = summarizeWindows(buckets)!;
    const index = indexRecordsByTimestamp(data);
    const attribution = expectBreakdown(attributeRange(buckets, index)!);
    expect(attribution.actualDelta).toBe(summary.totalDelta);
    expect(attribution.startScore).toBe(buckets[0].endScore);
    expect(attribution.endScore).toBe(buckets[buckets.length - 1].endScore);
    expectReconciled(attribution);
  });

  it('窗口级归因与该窗口的 deltaVsPrevWindow 一致', () => {
    const data: HealthScoreData[] = [
      makeRecord({ timestamp: new Date(2026, 9, 20, 9).toISOString() }),
      makeRecord({
        timestamp: new Date(2026, 9, 21, 9).toISOString(),
        scores: { quality: 90 },
      }),
      makeRecord({
        timestamp: new Date(2026, 9, 22, 9).toISOString(),
        scores: { quality: 90, deps: 80 },
      }),
    ];
    const buckets = buildWindowBuckets(data, 'day');
    const index = indexRecordsByTimestamp(data);
    for (let i = 1; i < buckets.length; i += 1) {
      const result = expectBreakdown(attributeWindowVsPrev(buckets, i, index)!);
      expect(result.actualDelta).toBe(buckets[i].deltaVsPrevWindow);
      expectReconciled(result);
    }
    // 首窗口没有上一期 ⇒ 不给归因（不编造基线）
    expect(attributeWindowVsPrev(buckets, 0, index)).toBeNull();
  });

  it('记录缺失时返回 null 而不是拿相邻记录顶替', () => {
    const data: HealthScoreData[] = [makeRecord({ timestamp: new Date(2026, 9, 20, 9).toISOString() })];
    const buckets = buildWindowBuckets(data, 'day');
    const emptyIndex = indexRecordsByTimestamp([]);
    expect(attributeRange(buckets, emptyIndex)).toBeNull();
    expect(attributeWindowVsPrev(buckets, 0, emptyIndex)).toBeNull();
  });
});

describe('结构项主导判定（防止把口径变化当成改进成果）', () => {
  /** 真实场景复刻：域分完全没变，只是参与域从 5 个变成 10 个，平均分被抬上去 */
  const narrow = makeRecord({
    timestamp: '2026-10-01T10:00:00.000Z',
    notRun: ['techdebt', 'gate', 'sentinel', 'garbage', 'backup'],
    scores: { quality: 83.8, security: 83.8, dependencies: 83.8, refactor: 83.8, performance: 83.8 },
  });
  const wide = makeRecord({
    timestamp: '2026-10-02T10:00:00.000Z',
    scores: { quality: 83.8, security: 83.8, dependencies: 83.8, refactor: 83.8, performance: 83.8 },
  });

  it('参与域 5 → 10 且域分不变：判为结构主导', () => {
    const result = expectBreakdown(attributeScoreDelta(narrow, wide));
    expect(result.actualDelta).toBeCloseTo(8.1, 1);
    expect(result.domainsPoints).toBe(0); // 没有任何域真的变化
    expect(result.structurePoints).toBeCloseTo(8.1, 1);
    expect(isStructureDominated(result)).toBe(true);
    expectReconciled(result);
  });

  it('域分数真的变化时不算结构主导', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      scores: { security: 60 },
    });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(result.structurePoints).toBe(0);
    expect(isStructureDominated(result)).toBe(false);
  });

  it('变化太小时不警示（避免噪声刷屏）', () => {
    const start = makeRecord({
      timestamp: '2026-10-01T10:00:00.000Z',
      notRun: ['backup'],
    });
    const end = makeRecord({ timestamp: '2026-10-02T10:00:00.000Z', scores: { backup: 99 } });
    const result = expectBreakdown(attributeScoreDelta(start, end));
    expect(Math.abs(result.actualDelta)).toBeLessThan(0.5);
    expect(isStructureDominated(result)).toBe(false);
  });
});

describe('占比工具', () => {
  it('占比用绝对贡献除以总和，实际变化为 0 时也不炸', () => {
    const start = makeRecord({ timestamp: '2026-10-01T10:00:00.000Z' });
    // security -10、quality +10：域贡献相互抵消，实际总变化 ≈ 0
    const end = makeRecord({
      timestamp: '2026-10-02T10:00:00.000Z',
      scores: { security: 90, quality: 100 },
    });
    const neutralStart = makeRecord({
      timestamp: '2026-10-01T10:00:00.000Z',
      scores: { security: 100 },
    });
    const result = expectBreakdown(attributeScoreDelta(neutralStart, end));
    expect(Math.abs(result.actualDelta)).toBeLessThanOrEqual(1);
    const total = totalAbsolutePoints(result.domains);
    expect(total).toBeCloseTo(1, 1);
    const share = contributionShare(result.domains[0].points, total);
    expect(Number.isFinite(share)).toBe(true);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(1);
    expect(contributionShare(0, 0)).toBe(0);
    expect(contributionShare(-5, 0)).toBe(0);
    expect(contributionShare(-10, 10)).toBe(1);
    // start 参与的部分只用于保证构造有效
    expect(start.score).toBe(100);
  });
});
