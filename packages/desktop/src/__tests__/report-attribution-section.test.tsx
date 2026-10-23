/**
 * 「分数变化归因」区块的渲染守卫。
 *
 * 锁五件事：
 * 1) 默认按区间拆解，与「区间总变化」是同一个差值；
 * 2) 拉低 / 拉高把维度名与贡献分直接写出来 —— 这是用户唯一能拿去行动的结论；
 * 3) 有效权重显示归一化后的百分比（9 域参与时是 11.1% 而不是 10%）；
 * 4) **口径变化单独成行**（参与域 9 → 10），不摊给任何具体域；
 * 5) 数据自相矛盾时必须标「归因未闭合」—— 这是判据会红的负向自证，
 *    只测「正常数据能显示 ✓」会得到一个永远绿的假门禁。
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { AttributionSection, attributionOptions, resolveAttribution } from '../pages/report-attribution-parts';
import { buildWindowBuckets } from '../pages/report-windows';
import { attributeRange, indexRecordsByTimestamp } from '../pages/report-attribution';
import type { HealthScoreData } from '../types/electron';

// node 环境 navigator.language 为 en-US，固定中文，断言才锚得住文案
vi.stubGlobal('navigator', { language: 'zh-Hans' });

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

function rec(input: {
  timestamp: string;
  scores?: Partial<Record<DomainName, number>>;
  notRun?: readonly DomainName[];
  scoreVersion?: number;
  /** 显式总分（用于构造自相矛盾的数据做负向自证） */
  overall?: number;
}): HealthScoreData {
  const notRun = new Set(input.notRun ?? []);
  const dimensions = DOMAINS.map((name) => {
    const score = input.scores?.[name] ?? 100;
    return notRun.has(name)
      ? { name, score: 0, weight: 0.1, status: 'not-run' as const }
      : { name, score, weight: 0.1 };
  });
  const active = dimensions.filter((d) => d.status !== 'not-run');
  const weightSum = active.reduce((sum, d) => sum + d.weight, 0);
  const raw =
    weightSum > 0 ? active.reduce((sum, d) => sum + d.score * d.weight, 0) / weightSum : 0;
  return {
    score: input.overall ?? Math.round(raw * 100) / 100,
    dimensions,
    summary: 'ok',
    timestamp: input.timestamp,
    ...(typeof input.scoreVersion === 'number' ? { scoreVersion: input.scoreVersion } : {}),
  };
}

function localIso(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

/** 自洽的三天历史：100 → 97 → 94，三个域分别下跌 */
const CONSISTENT: HealthScoreData[] = [
  rec({ timestamp: localIso(2026, 10, 20) }),
  rec({ timestamp: localIso(2026, 10, 21), scores: { security: 80, quality: 90 } }),
  rec({ timestamp: localIso(2026, 10, 22), scores: { security: 80, quality: 90, dependencies: 70 } }),
];

function render(data: HealthScoreData[]): string {
  const buckets = buildWindowBuckets(data, 'day');
  return renderToStaticMarkup(
    <I18nProvider>
      <AttributionSection data={data} buckets={buckets} />
    </I18nProvider>,
  );
}

describe('AttributionSection', () => {
  it('区间归因把总变化拆到具体域，并给出可读的拉低清单', () => {
    const html = render(CONSISTENT);
    expect(html).toContain('分数变化归因');
    // 100 → 94，总变化 -6
    expect(html).toContain('-6');
    expect(html).toContain('拉低');
    // 三个下跌的域按贡献排序：依赖 -3、安全性 -2、质量 -1
    expect(html).toContain('依赖');
    expect(html).toContain('安全性');
    expect(html).toContain('-3');
    expect(html).toContain('-2');
  });

  it('表格逐域列出上期分 / 本期分 / 域内变化 / 有效权重 / 贡献', () => {
    const html = render(CONSISTENT);
    expect(html).toContain('上期分');
    expect(html).toContain('本期分');
    expect(html).toContain('域内变化');
    expect(html).toContain('有效权重');
    expect(html).toContain('贡献总分');
    // 十域满参与 ⇒ 有效权重就是 10%
    expect(html).toContain('10%');
    // dependencies 100 → 70
    expect(html).toContain('-30');
  });

  it('对账条显示「已对账」：域贡献 + 结构项 + 封顶项 = 实际变化', () => {
    const html = render(CONSISTENT);
    expect(html).toContain('✓ 已对账');
    expect(html).toContain('域贡献');
    expect(html).toContain('实际');
  });

  it('口径变化单独成行：参与域 9 → 10 且列出新增的域', () => {
    const data: HealthScoreData[] = [
      rec({ timestamp: localIso(2026, 10, 20), notRun: ['backup'] }),
      rec({ timestamp: localIso(2026, 10, 21), scores: { backup: 50 } }),
    ];
    const html = render(data);
    expect(html).toContain('结构项（口径变化）');
    expect(html).toContain('参与域 9 → 10');
    expect(html).toContain('新增参与：备份');
    // 新增域没有上期分 ⇒ 不许给它编一个域贡献
    expect(html).toContain('✓ 已对账');
  });

  it('未检测域不退化成 0 分贡献（只跑 9 个域时有效权重是 11.1%）', () => {
    const data: HealthScoreData[] = [
      rec({ timestamp: localIso(2026, 10, 20), notRun: ['backup'] }),
      rec({ timestamp: localIso(2026, 10, 21), notRun: ['backup'], scores: { security: 80 } }),
    ];
    const html = render(data);
    expect(html).toContain('11.1%');
    // 安全 100 → 80，贡献 = -20 × 1/9 ≈ -2.22
    expect(html).toContain('-2.22');
  });

  it('数据自相矛盾时标「归因未闭合」，不假装已对账（判据会红）', () => {
    const data: HealthScoreData[] = [
      rec({ timestamp: localIso(2026, 10, 20) }),
      // 域分全是 100，总分却写 50 —— 真实链路不可能出现，这里用来验证判据确实会红
      rec({ timestamp: localIso(2026, 10, 21), overall: 50 }),
    ];
    const html = render(data);
    expect(html).toContain('✗ 归因未闭合');
    expect(html).not.toContain('✓ 已对账');
  });

  it('跨评分版本的记录只给原因，不给归因表', () => {
    const data: HealthScoreData[] = [
      rec({ timestamp: localIso(2026, 10, 20), scoreVersion: 1 }),
      rec({ timestamp: localIso(2026, 10, 21), scoreVersion: 2, scores: { security: 80 } }),
    ];
    const html = render(data);
    expect(html).toContain('评分算法版本');
    expect(html).not.toContain('✓ 已对账');
    expect(html).not.toContain('贡献总分');
  });

  it('变化主要来自口径时给出警示：分数涨了但不是任何域变好', () => {
    const data: HealthScoreData[] = [
      rec({
        timestamp: localIso(2026, 10, 20),
        notRun: ['techdebt', 'gate', 'sentinel', 'garbage', 'backup'],
        scores: {
          quality: 83.8,
          security: 83.8,
          dependencies: 83.8,
          refactor: 83.8,
          performance: 83.8,
        },
      }),
      // 域分完全没变，只是多跑了 5 个域 ⇒ 平均分被抬上去
      rec({
        timestamp: localIso(2026, 10, 21),
        scores: {
          quality: 83.8,
          security: 83.8,
          dependencies: 83.8,
          refactor: 83.8,
          performance: 83.8,
        },
      }),
    ];
    const html = render(data);
    expect(html).toContain('参与加权的域数量变化');
    expect(html).toContain('5 个 → 10 个');
    // 同时不许把这次「上涨」显示成任何域的贡献
    expect(html).toContain('拉低');
    expect(html).toContain('✓ 已对账');
  });

  it('只有一个窗口时不渲染整块（单点不能算趋势）', () => {
    expect(render([CONSISTENT[0]])).toBe('');
    expect(render([])).toBe('');
  });

  it('渲染结果不含 NaN / undefined', () => {
    const html = render(CONSISTENT);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('Infinity');
  });
});

describe('归因范围选项', () => {
  it('首个选项是区间，其后每个窗口一个「较上期」', () => {
    const buckets = buildWindowBuckets(CONSISTENT, 'day');
    const options = attributionOptions(buckets);
    expect(options).toHaveLength(1 + (buckets.length - 1));
    expect(options[0].value).toBe('range');
    expect(options[0].label).toBe(`${buckets[0].label} → ${buckets[2].label}`);
    expect(options[1].label).toBe(`${buckets[0].label} → ${buckets[1].label}`);
  });

  it('区间选项的归因与 attributeRange 同源', () => {
    const buckets = buildWindowBuckets(CONSISTENT, 'day');
    const index = indexRecordsByTimestamp(CONSISTENT);
    const fromOptions = resolveAttribution('range', buckets, index);
    const direct = attributeRange(buckets, index);
    expect(fromOptions).toEqual(direct);
  });

  it('失效的范围值返回 null 而不是取相邻窗口顶替', () => {
    const buckets = buildWindowBuckets(CONSISTENT, 'day');
    const index = indexRecordsByTimestamp(CONSISTENT);
    expect(resolveAttribution('2026-01-01', buckets, index)).toBeNull();
    expect(attributionOptions(buildWindowBuckets([CONSISTENT[0]], 'day'))).toEqual([]);
  });
});
