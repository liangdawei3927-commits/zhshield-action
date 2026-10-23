/**
 * 数据缺口标注的单测。
 *
 * 为什么单独一个文件：这里钉的不是「窗口怎么分」，而是「报告会不会骗人」。
 *
 * 真实事故（2026-10-24 实测某项目 scores 表）：2026-09-09 之后到 2026-10-20
 * 之间 **41 天零记录**，月报却依然输出「2026-09 85.7 → 2026-10 90.3，较上期 +4.6」，
 * 三个窗口一个不缺、覆盖率 100%，读者会把 45 天的变化当成一个月的趋势。
 *
 * 所以这里锁三件事：
 * 1. 间隔按**本地日历日**算，不受时分与夏令时影响；
 * 2. **覆盖率** 与 **最大空档** 是两个独立指标，不可互相替代（月报可以 100% 覆盖却有 41 天空档）；
 * 3. 「较上期」必须带上它实际跨越的天数。
 */

import { describe, expect, it } from 'vitest';
import type { HealthScoreData } from '../types/electron';
import {
  buildWindowBuckets,
  calendarDaysBetween,
  countExpectedWindows,
  summarizeWindows,
} from '../pages/report-windows';

/** 本地时间构造（不写 ISO 字符串：那会按 UTC 解释，在非 GMT+8 机器上错一天） */
function localTime(y: number, m: number, d: number, h = 12, min = 0, sec = 0): string {
  return new Date(y, m - 1, d, h, min, sec).toISOString();
}

function score(timestamp: string, value: number): HealthScoreData {
  return {
    score: value,
    timestamp,
    summary: 'ok',
    dimensions: [{ name: 'quality', score: value, weight: 0.1 }],
  } as HealthScoreData;
}

/**
 * 真实评分历史（取自项目 scores 表，project_id=/Users/dawei/Desktop/ZHCodeShield）。
 *
 * 保留真实的时间分布：8-29 起、9-09 后断档 41 天、10-20 起密集。
 * 分数为真实值，用于验证「较上期」等数字不被缺口逻辑改动。
 */
const REAL_HISTORY: HealthScoreData[] = [
  score(localTime(2026, 8, 29, 13, 40, 9), 98.6),
  score(localTime(2026, 8, 29, 14, 33, 12), 98.6),
  score(localTime(2026, 8, 30, 14, 16, 42), 100.0),
  score(localTime(2026, 9, 1, 18, 41, 39), 99.0),
  score(localTime(2026, 9, 2, 14, 10, 25), 99.4),
  score(localTime(2026, 9, 3, 18, 47, 11), 83.7),
  score(localTime(2026, 9, 4, 16, 12, 35), 90.1),
  score(localTime(2026, 9, 5, 3, 6, 51), 89.8),
  score(localTime(2026, 9, 8, 15, 5, 0), 100.0),
  score(localTime(2026, 9, 8, 18, 48, 32), 85.7),
  score(localTime(2026, 9, 9, 0, 10, 59), 85.7),
  score(localTime(2026, 10, 20, 23, 56, 26), 88.2),
  score(localTime(2026, 10, 21, 15, 57, 1), 82.1),
  score(localTime(2026, 10, 22, 23, 20, 21), 90.0),
  score(localTime(2026, 10, 23, 23, 57, 56), 86.3),
  score(localTime(2026, 10, 24, 0, 16, 19), 90.3),
];

describe('calendarDaysBetween', () => {
  it('按日历日算，不按毫秒：23:56 → 次日 00:16 算 1 天', () => {
    expect(
      calendarDaysBetween(localTime(2026, 10, 20, 23, 56), localTime(2026, 10, 21, 0, 16)),
    ).toBe(1);
  });

  it('同一天不同时刻算 0 天', () => {
    expect(calendarDaysBetween(localTime(2026, 10, 23, 1, 0), localTime(2026, 10, 23, 23, 59))).toBe(
      0,
    );
  });

  it('跨月按真实天数：9-09 → 10-20 是 41 天', () => {
    expect(calendarDaysBetween(localTime(2026, 9, 9, 0, 10), localTime(2026, 10, 20, 23, 56))).toBe(
      41,
    );
  });

  it('非法输入返回 0，不抛错也不返回 NaN（NaN 会污染整个缺口判断）', () => {
    expect(calendarDaysBetween('not-a-date', localTime(2026, 10, 24))).toBe(0);
  });
});

describe('countExpectedWindows', () => {
  it('日粒度按天数枚举，含两端', () => {
    expect(countExpectedWindows('2026-10-22', '2026-10-24', 'day')).toBe(3);
    expect(countExpectedWindows('2026-10-24', '2026-10-24', 'day')).toBe(1);
  });

  it('月粒度含两端且不按 30 天估算', () => {
    expect(countExpectedWindows('2026-08', '2026-10', 'month')).toBe(3);
    expect(countExpectedWindows('2026-01', '2027-01', 'month')).toBe(13);
  });

  it('年粒度含两端', () => {
    expect(countExpectedWindows('2025', '2026', 'year')).toBe(2);
  });

  it('倒序区间返回 0（不是负数，负数会算出覆盖率 > 100%）', () => {
    expect(countExpectedWindows('2026-10-24', '2026-10-22', 'day')).toBe(0);
  });
});

describe('buildWindowBuckets 缺口标注', () => {
  it('把粒度写进每个窗口，供上层零推断使用', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'month');
    expect(buckets.every((bucket) => bucket.granularity === 'month')).toBe(true);
  });

  it('首窗口 gapDays 为 null —— 数据之前发生了什么不可知，不能当成缺口', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'day');
    expect(buckets[0].gapDays).toBeNull();
    expect(buckets[0].isGap).toBe(false);
    expect(buckets[0].deltaSpanDays).toBeNull();
  });

  it('日报：41 天断档被识别为缺口，间隔与起止时间一致', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'day');
    const oct20 = buckets.find((bucket) => bucket.key === '2026-10-20')!;
    expect(oct20.gapDays).toBe(41);
    expect(oct20.isGap).toBe(true);
    // 较上期实际跨了 41 + 1（10-20 当天自身）= 42 天
    expect(oct20.deltaSpanDays).toBe(41);
  });

  it('日报：连续两天有记录时不算缺口（gapDays = 1 不超过阈值）', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'day');
    const oct21 = buckets.find((bucket) => bucket.key === '2026-10-21')!;
    expect(oct21.gapDays).toBe(1);
    expect(oct21.isGap).toBe(false);
  });

  it('月报：窗口一个不缺，但 2026-10 仍被标为缺口', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'month');
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    const oct = buckets.find((bucket) => bucket.key === '2026-10')!;
    // 9-09 末次 → 10-20 首次 = 41 天，超过月报 31 天阈值
    expect(oct.gapDays).toBe(41);
    expect(oct.isGap).toBe(true);
  });

  it('月报：「较上期」标注真实跨度 45 天，不是一个月', () => {
    const buckets = buildWindowBuckets(REAL_HISTORY, 'month');
    const oct = buckets.find((bucket) => bucket.key === '2026-10')!;
    expect(oct.deltaVsPrevWindow).toBe(4.6); // 90.3 - 85.7
    // 9-09 末次 → 10-24 末次 = 45 天
    expect(oct.deltaSpanDays).toBe(45);
  });
});

describe('summarizeWindows 可观测性指标', () => {
  it('日报：覆盖率按应有天数算，缺口天数可见', () => {
    const summary = summarizeWindows(buildWindowBuckets(REAL_HISTORY, 'day'))!;
    // 8-29 → 10-24 共 56 天差 → 57 个日窗口
    expect(summary.spanDays).toBe(56);
    expect(summary.expectedWindows).toBe(57);
    expect(summary.windows).toBe(14);
    expect(summary.missingWindows).toBe(43);
    expect(summary.coverage).toBeCloseTo(14 / 57, 5);
    expect(summary.maxGapDays).toBe(41);
    expect(summary.maxGapWindow?.key).toBe('2026-10-20');
  });

  it('月报：覆盖率 100% 但 gapCount = 1 —— 两个指标不可互相替代', () => {
    const summary = summarizeWindows(buildWindowBuckets(REAL_HISTORY, 'month'))!;
    expect(summary.windows).toBe(3);
    expect(summary.expectedWindows).toBe(3);
    expect(summary.missingWindows).toBe(0);
    expect(summary.coverage).toBe(1);
    // 覆盖率满格，仍然有 1 段空档：这正是「被折叠掉的 41 天」
    expect(summary.gapCount).toBe(1);
    expect(summary.maxGapDays).toBe(41);
  });

  it('连续无缺口的数据 gapCount = 0，不能把所有窗口都标成缺口', () => {
    const dense = buildWindowBuckets(
      [
        score(localTime(2026, 10, 22, 10), 80),
        score(localTime(2026, 10, 23, 10), 82),
        score(localTime(2026, 10, 24, 10), 84),
      ],
      'day',
    );
    const summary = summarizeWindows(dense)!;
    expect(summary.gapCount).toBe(0);
    expect(summary.missingWindows).toBe(0);
    expect(summary.maxGapDays).toBe(1);
  });

  it('缺口标注不改变原有趋势数字（回归护栏）', () => {
    const summary = summarizeWindows(buildWindowBuckets(REAL_HISTORY, 'month'))!;
    // 8 月期末 = 8-30 那次 100.0（不是 8-29 的 98.6），故 90.3 - 100.0 = -9.7
    expect(summary.totalDelta).toBe(-9.7);
    expect(summary.bestScore).toBe(100);
    expect(summary.worstScore).toBe(85.7);
  });
});
