/**
 * 时间窗聚合的单测。
 *
 * 这里钉的是「报告会不会算错」，不是「代码能不能跑」：
 * 分桶错一天、delta 口径混用、维度变化虚假归零，都会让用户拿到一份
 * 看起来专业但结论错误的日报。
 */

import { describe, expect, it } from 'vitest';
import type { HealthScoreData } from '../types/electron';
import {
  buildWindowBuckets,
  summarizeWindows,
  windowKeyOf,
} from '../pages/report-windows';

/** 构造一条评分记录；dimensions 默认给两个维度，便于验证维度变化 */
function score(
  timestamp: string,
  value: number,
  dims: Array<[string, number, ('scored' | 'not-run')?]> = [
    ['quality', value],
    ['refactor', value],
  ],
): HealthScoreData {
  return {
    score: value,
    timestamp,
    summary: 'ok',
    dimensions: dims.map(([name, s, status]) => ({
      name,
      score: s,
      weight: 0.1,
      ...(status ? { status } : {}),
    })),
  } as HealthScoreData;
}

describe('windowKeyOf', () => {
  it('按本地日期分桶：23:57 仍算当天，不因 UTC 掉到前一天', () => {
    const late = new Date(2026, 9, 23, 23, 57); // 本地 2026-10-23 23:57
    expect(windowKeyOf(late, 'day').key).toBe('2026-10-23');
  });

  it('周键取所在周的周一，标签跨到周日', () => {
    // 2026-10-24 是周六 → 周一为 2026-10-19
    const sat = new Date(2026, 9, 24, 10, 0);
    const { key, label } = windowKeyOf(sat, 'week');
    expect(key).toBe('2026-10-19');
    expect(label).toBe('2026-10-19 ~ 10-25');
  });

  it('周日归入上一周的周一（不是下一周）', () => {
    // 2026-10-25 是周日，应归入 2026-10-19 那周
    const sun = new Date(2026, 9, 25, 23, 0);
    expect(windowKeyOf(sun, 'week').key).toBe('2026-10-19');
  });

  it('月 / 年键补零对齐，字典序即时间序', () => {
    expect(windowKeyOf(new Date(2026, 0, 5), 'month').key).toBe('2026-01');
    expect(windowKeyOf(new Date(2026, 11, 31), 'year').key).toBe('2026');
    expect('2026-01' < '2026-10').toBe(true);
  });

  it('非法时间戳不抛错，返回 invalid', () => {
    expect(windowKeyOf('not-a-date', 'day').key).toBe('invalid');
  });
});

describe('buildWindowBuckets', () => {
  it('空历史返回空数组，不造空窗口', () => {
    expect(buildWindowBuckets([], 'day')).toEqual([]);
  });

  it('同一天多次扫描 → 一个窗口：期末取最后一次，min/max 表示波动', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-23T03:22:00.000Z', 89.7),
        score('2026-10-23T06:32:00.000Z', 90.2),
        score('2026-10-23T13:11:00.000Z', 86.3),
      ],
      'day',
    );
    expect(buckets).toHaveLength(1);
    const day = buckets[0];
    expect(day.scans).toBe(3);
    expect(day.startScore).toBe(89.7);
    expect(day.endScore).toBe(86.3);
    expect(day.delta).toBe(-3.4);
    expect(day.minScore).toBe(86.3);
    expect(day.maxScore).toBe(90.2);
    expect(day.avgScore).toBe(88.7);
  });

  it('跨窗口 deltaVsPrevWindow 用上一窗口期末，而非上一窗口首次', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-22T02:00:00.000Z', 80),
        score('2026-10-22T08:00:00.000Z', 90),
        score('2026-10-23T02:00:00.000Z', 95),
      ],
      'day',
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].deltaVsPrevWindow).toBeNull();
    // 95 - 90（上一窗口期末），不是 95 - 80
    expect(buckets[1].deltaVsPrevWindow).toBe(5);
  });

  it('输入乱序也按时间升序输出，且首末取真实首末', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-24T08:00:00.000Z', 91),
        score('2026-10-24T01:00:00.000Z', 88),
      ],
      'day',
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].startScore).toBe(88);
    expect(buckets[0].endScore).toBe(91);
    expect(buckets[0].delta).toBe(3);
  });

  it('维度变化按同维度首末相减，未检测维度保留 status', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-23T01:00:00.000Z', 80, [
          ['quality', 80],
          ['refactor', 60, 'scored'],
        ]),
        score('2026-10-23T09:00:00.000Z', 85, [
          ['quality', 90],
          ['refactor', 60, 'scored'],
          ['backup', 0, 'not-run'],
        ]),
      ],
      'day',
    );
    const dims = buckets[0].dimensions;
    expect(dims.find((d) => d.name === 'quality')).toMatchObject({ endScore: 90, delta: 10 });
    expect(dims.find((d) => d.name === 'refactor')).toMatchObject({ endScore: 60, delta: 0 });
    // 新出现的未检测维度：delta=0 且带 status，UI 不能按「跌了 0 分」显示
    expect(dims.find((d) => d.name === 'backup')).toMatchObject({
      endScore: 0,
      delta: 0,
      status: 'not-run',
    });
  });

  it('周粒度把同一周不同天合并成一个窗口', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-19T02:00:00.000Z', 80), // 周一
        score('2026-10-24T02:00:00.000Z', 90), // 周六
        score('2026-10-26T02:00:00.000Z', 70), // 下周一
      ],
      'week',
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].scans).toBe(2);
    expect(buckets[0].delta).toBe(10);
    expect(buckets[1].scans).toBe(1);
  });
});

describe('summarizeWindows', () => {
  it('不足两个窗口时返回 null —— 单点不能算趋势', () => {
    const one = buildWindowBuckets([score('2026-10-23T02:00:00.000Z', 88)], 'day');
    expect(summarizeWindows(one)).toBeNull();
    expect(summarizeWindows([])).toBeNull();
  });

  it('给出总变化、扫描总数与跌幅最大窗口', () => {
    const buckets = buildWindowBuckets(
      [
        score('2026-10-21T02:00:00.000Z', 95),
        score('2026-10-22T02:00:00.000Z', 90),
        score('2026-10-23T02:00:00.000Z', 70),
        score('2026-10-24T02:00:00.000Z', 72),
      ],
      'day',
    );
    const summary = summarizeWindows(buckets)!;
    expect(summary.windows).toBe(4);
    expect(summary.scans).toBe(4);
    expect(summary.totalDelta).toBe(-23);
    expect(summary.bestScore).toBe(95);
    expect(summary.worstScore).toBe(70);
    // 10-23 掉了 20 分，是最大跌幅窗口
    expect(summary.worstWindow?.key).toBe('2026-10-23');
  });

  it('全程不跌时 worstWindow 为 null，不强行找背锅窗口', () => {
    const buckets = buildWindowBuckets(
      [score('2026-10-22T02:00:00.000Z', 80), score('2026-10-23T02:00:00.000Z', 85)],
      'day',
    );
    expect(summarizeWindows(buckets)!.worstWindow).toBeNull();
  });
});
