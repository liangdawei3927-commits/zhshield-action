/**
 * 报告中心的时间窗聚合（日 / 周 / 月 / 年）。
 *
 * 为什么必须是纯函数：窗口归属、跨窗口对比、维度变化这三件事直接决定
 * 「报告有没有在骗人」，必须能被单测钉死；页面只负责渲染。
 *
 * 口径约定（同样要写进 UI，否则用户无法判断可比性）：
 * - 一个窗口内可能扫了多次，**期末分数取该窗口最后一次**，同时保留 min/max 表示期内波动；
 * - `delta` = 窗口内首末之差 → 回答「这一天/这周里项目变好还是变差」；
 * - `deltaVsPrevWindow` = 相邻窗口期末之差 → 回答「比上一期好还是差」；
 * - 两者**不可混用**：前者是期内波动，后者是跨期趋势。
 *
 * 时间一律按**本地时区**分桶。用 UTC 分桶会让 GMT+8 用户的晚间扫描掉到前一天，
 * 「日报」直接算错一天。
 *
 * ## 为什么必须算「数据缺口」
 *
 * 只列出「有数据的窗口」会骗人：实测某项目 2026-09-09 与 2026-10-20 之间
 * 41 天没有任何记录，月报里却仍然显示「2026-09 期末 85.7 → 2026-10 期末 90.3」，
 * 三个窗口一个不缺（覆盖率 100%），读者会把它当成「一个月涨了 4.6 分」。
 * 实际上那 4.6 分是跨 45 天、跨越整段空档比出来的，不是一个月的趋势。
 *
 * 所以窗口列表之外必须同时给出两个独立指标：
 * - **覆盖率**（有数据的窗口数 ÷ 应有窗口数）：回答「这段时间有多少天在被观测」；
 * - **最大空档**（相邻两次扫描之间最长的间隔天数）：回答「这次比较跨了多久」。
 * 两者互不可替代：月报覆盖率可以 100% 而空档 41 天。
 */

import type { HealthScoreData } from '../types/electron';

/** 时间窗粒度 */
export type WindowGranularity = 'day' | 'week' | 'month' | 'year';

/** 单窗口内的维度变化 */
export interface WindowDimension {
  name: string;
  /** 该窗口最后一次的分数 */
  endScore: number;
  /** 窗口内首末之差（同维度） */
  delta: number;
  /** 未检测的维度不参与总分加权，UI 要区别显示 */
  status?: 'scored' | 'not-run';
}

/** 一个时间窗口的聚合结果 */
export interface WindowBucket {
  /** 排序键，字典序即时间序（日 `2026-10-24` / 周 `2026-10-19` / 月 `2026-10` / 年 `2026`） */
  key: string;
  /**
   * 该窗口所属粒度。
   *
   * 冗余存一份是有意的：`summarizeWindows(buckets)` 要算「应有窗口数」必须知道粒度，
   * 而按 key 形态反推会把「10-19 恰好是周一」误判成周窗口。
   * 直接带上，下游零推断。
   */
  granularity: WindowGranularity;
  /** 展示标签 */
  label: string;
  /** 窗口内扫描次数 */
  scans: number;
  /** 窗口内最早一次的时间戳 */
  startAt: string;
  /** 窗口内最后一次的时间戳 */
  endAt: string;
  startScore: number;
  endScore: number;
  /** 期内变化 = endScore - startScore */
  delta: number;
  minScore: number;
  maxScore: number;
  avgScore: number;
  /** 与上一个窗口期末相比的变化；无上一窗口时为 null（不是 0 —— 0 会被读成「没变化」） */
  deltaVsPrevWindow: number | null;
  dimensions: WindowDimension[];
  /**
   * 距上一个**有数据的**窗口末次扫描过了多少个日历天；首窗口为 null。
   * 注意这是「本窗口第一条记录」往回看的间隔 —— 即用户停了多久才重新检查。
   */
  gapDays: number | null;
  /** `gapDays` 超过该粒度的正常间隔 ⇒ 本次比较跨过了一段空档，不能当作连续趋势读 */
  isGap: boolean;
  /**
   * `deltaVsPrevWindow` 实际跨越的日历天数（上一窗口末次 → 本窗口末次）。
   * 没有上一窗口时为 null。用来给「较上期 -4.6」标注它到底是 1 天还是 45 天比出来的。
   */
  deltaSpanDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 每个粒度「正常数据间隔」的上限（天）。超过即视为缺口。
 *
 * 取的是**粒度本身**而不是更大的数：日报正常就该天天有，隔 1 天没扫就是断档。
 * 这里刻意严格 —— 宁可多标缺口，也不要让断档看起来像连续趋势。
 */
const GAP_THRESHOLD_DAYS: Record<WindowGranularity, number> = {
  day: 1,
  week: 7,
  month: 31,
  year: 366,
};

/** 本地零点。用 `new Date(y,m,d)` 而不是 `setHours(0,0,0,0)`，避免夏令时跨日 */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 两个时间戳之间的**本地日历日**差（正数表示 to 晚于 from）。
 *
 * 用日期归一化再相减，不用原始毫秒差：后者会把「23:00 → 次日 01:00」
 * 算成 0.08 天，四舍五入后成 0 天，缺口就被抹平了。
 */
export function calendarDaysBetween(
  from: string | number | Date,
  to: string | number | Date,
): number {
  const a = startOfLocalDay(from instanceof Date ? from : new Date(from));
  const b = startOfLocalDay(to instanceof Date ? to : new Date(to));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** 本地日期 → `YYYY-MM-DD`（不用 toISOString：那会转成 UTC 而错一天） */
function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 该日期所在周的周一（本地零点）。周一起算，符合国内习惯 */
function startOfWeek(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = monday.getDay(); // 0 = 周日
  monday.setDate(monday.getDate() + (dow === 0 ? -6 : 1 - dow));
  return monday;
}

/** 时间戳 → 窗口键与展示标签 */
export function windowKeyOf(
  timestamp: string | number | Date,
  granularity: WindowGranularity,
): { key: string; label: string } {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { key: 'invalid', label: '—' };
  switch (granularity) {
    case 'day': {
      const key = localDateKey(date);
      return { key, label: key };
    }
    case 'week': {
      const monday = startOfWeek(date);
      const sunday = new Date(monday.getTime() + 6 * DAY_MS);
      const key = localDateKey(monday);
      return { key, label: `${key} ~ ${localDateKey(sunday).slice(5)}` };
    }
    case 'month': {
      const key = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
      return { key, label: key };
    }
    case 'year': {
      const key = `${date.getFullYear()}`;
      return { key, label: key };
    }
  }
}

/** 窗口键 → 该窗口的起始本地日期（月 / 年键按窗口首日）；非法键返回 null */
function parseWindowKey(key: string, granularity: WindowGranularity): Date | null {
  const parts = key.split('-').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m = 1, d = 1] = parts;
  if (granularity === 'year') return new Date(y, 0, 1);
  if (granularity === 'month') return new Date(y, m - 1, 1);
  return new Date(y, m - 1, d);
}

/** 窗口按键推进一个粒度 */
function nextWindow(start: Date, granularity: WindowGranularity): Date {
  switch (granularity) {
    case 'day':
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    case 'week':
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    case 'month':
      return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    case 'year':
      return new Date(start.getFullYear() + 1, 0, 1);
  }
}

/**
 * 从 `fromKey` 到 `toKey` 之间**应有**多少个窗口（含两端）。
 *
 * 这是覆盖率的分母：有数据的窗口数 ÷ 应有窗口数。分母按日历枚举，
 * 不用 `spanDays / 粒度天数` 估算 —— 月有 28~31 天、周有跨月，估算法会算出小数窗口。
 *
 * 迭代上限 40000 次只是防御异常输入（100 年的日报 ≈ 36500 个窗口，足够）。
 */
export function countExpectedWindows(
  fromKey: string,
  toKey: string,
  granularity: WindowGranularity,
): number {
  const from = parseWindowKey(fromKey, granularity);
  const to = parseWindowKey(toKey, granularity);
  if (!from || !to || to.getTime() < from.getTime()) return 0;
  let count = 0;
  let cursor = from;
  while (cursor.getTime() <= to.getTime() && count < 40000) {
    count += 1;
    cursor = nextWindow(cursor, granularity);
  }
  return count;
}

/** 同维度首末变化；某一端缺失时按「无变化」处理，不臆造数值 */
function dimensionDeltas(start: HealthScoreData, end: HealthScoreData): WindowDimension[] {
  const startMap = new Map(start.dimensions.map((d) => [d.name, d]));
  return end.dimensions.map((d) => {
    const prev = startMap.get(d.name);
    return {
      name: d.name,
      endScore: d.score,
      delta: prev ? round1(d.score - prev.score) : 0,
      ...(d.status ? { status: d.status } : {}),
    };
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 把评分历史按时间窗聚合成「日/周/月/年」报告序列。
 *
 * @param history 评分历史（顺序不限，内部会按时间升序重排）
 * @param granularity 窗口粒度
 * @returns 窗口列表，**按时间升序**（与图表 X 轴方向一致）
 */
export function buildWindowBuckets(
  history: readonly HealthScoreData[],
  granularity: WindowGranularity,
): WindowBucket[] {
  if (history.length === 0) return [];

  const sorted = history.toSorted(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const groups = new Map<string, { label: string; items: HealthScoreData[] }>();
  for (const item of sorted) {
    const { key, label } = windowKeyOf(item.timestamp, granularity);
    const bucket = groups.get(key);
    if (bucket) bucket.items.push(item);
    else groups.set(key, { label, items: [item] });
  }

  const keys = [...groups.keys()].sort();
  const buckets: WindowBucket[] = [];
  let prevEndScore: number | null = null;
  /** 上一个有数据窗口的**末次扫描时间**，用于算间隔天数（不是窗口起点） */
  let prevLastAt: string | null = null;

  for (const key of keys) {
    const { label, items } = groups.get(key)!;
    const first = items[0];
    const last = items.at(-1)!;
    const scores = items.map((item) => item.score);
    const endScore = round1(last.score);
    const gapDays = prevLastAt === null ? null : calendarDaysBetween(prevLastAt, first.timestamp);
    const bucket: WindowBucket = {
      key,
      granularity,
      label,
      scans: items.length,
      startAt: first.timestamp,
      endAt: last.timestamp,
      startScore: round1(first.score),
      endScore,
      delta: round1(last.score - first.score),
      minScore: round1(Math.min(...scores)),
      maxScore: round1(Math.max(...scores)),
      avgScore: round1(scores.reduce((sum, s) => sum + s, 0) / scores.length),
      deltaVsPrevWindow: prevEndScore === null ? null : round1(endScore - prevEndScore),
      dimensions: dimensionDeltas(first, last),
      gapDays,
      isGap: gapDays !== null && gapDays > GAP_THRESHOLD_DAYS[granularity],
      deltaSpanDays: prevLastAt === null ? null : calendarDaysBetween(prevLastAt, last.timestamp),
    };
    buckets.push(bucket);
    prevEndScore = endScore;
    prevLastAt = last.timestamp;
  }

  return buckets;
}

/**
 * 汇总一段窗口序列的整体变化，供「报告首屏结论」使用。
 *
 * 返回 null 表示样本不足（0 或 1 个窗口）—— 此时任何「趋势」都是编的。
 *
 * 除趋势数字外**必须同时给出可观测性指标**（spanDays / coverage / maxGapDays）：
 * 「区间总变化 -8.1」如果不说是跨 56 天、其中 43 天没数据，读者会当成
 * 「这两天的变化」。
 */
export function summarizeWindows(buckets: readonly WindowBucket[]): {
  windows: number;
  scans: number;
  /** 首窗口期末 → 末窗口期末 */
  totalDelta: number;
  /** 期间最高 / 最低期末分 */
  bestScore: number;
  worstScore: number;
  /** 期末分下滑最多的窗口（归因用），无下滑时为 null */
  worstWindow: WindowBucket | null;
  /** 首窗口首次扫描 → 末窗口末次扫描的实际日历天数 */
  spanDays: number;
  /** 该跨度内按粒度应有的窗口数（含缺失）；分母 */
  expectedWindows: number;
  /** 完全没有数据的窗口数 = expectedWindows - windows */
  missingWindows: number;
  /** 覆盖率 0~1：有数据的窗口 ÷ 应有窗口 */
  coverage: number;
  /** 相邻两次扫描之间的最大间隔天数；全部记录不足两个时为 null */
  maxGapDays: number | null;
  /** 最大空档结束于哪个窗口（即「停了 N 天后重新检查」的那次） */
  maxGapWindow: WindowBucket | null;
  /** 超过粒度正常间隔的窗口数 */
  gapCount: number;
} | null {
  if (buckets.length < 2) return null;
  const first = buckets[0];
  const last = buckets.at(-1)!;
  let worstWindow: WindowBucket | null = null;
  for (const bucket of buckets) {
    const drop = bucket.deltaVsPrevWindow;
    if (drop === null || drop >= 0) continue;
    if (!worstWindow || drop < (worstWindow.deltaVsPrevWindow ?? 0)) worstWindow = bucket;
  }

  let maxGapWindow: WindowBucket | null = null;
  let gapCount = 0;
  for (const bucket of buckets) {
    if (bucket.gapDays === null) continue;
    if (bucket.isGap) gapCount += 1;
    if (!maxGapWindow || bucket.gapDays > (maxGapWindow.gapDays ?? 0)) maxGapWindow = bucket;
  }

  // 粒度直接取自窗口本身（buildWindowBuckets 写入），不做形态推断
  const expectedWindows = countExpectedWindows(first.key, last.key, first.granularity);

  return {
    windows: buckets.length,
    scans: buckets.reduce((sum, bucket) => sum + bucket.scans, 0),
    totalDelta: round1(last.endScore - first.endScore),
    bestScore: round1(Math.max(...buckets.map((b) => b.endScore))),
    worstScore: round1(Math.min(...buckets.map((b) => b.endScore))),
    worstWindow,
    spanDays: calendarDaysBetween(first.startAt, last.endAt),
    expectedWindows,
    missingWindows: Math.max(0, expectedWindows - buckets.length),
    coverage: expectedWindows > 0 ? buckets.length / expectedWindows : 1,
    maxGapDays: maxGapWindow?.gapDays ?? null,
    maxGapWindow,
    gapCount,
  };
}
